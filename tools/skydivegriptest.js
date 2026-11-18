// Sweep the actual glove morph and the two loaded risers through deployment.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { launchHardwareBrowser } from './browser.js';
import { startServer } from './server.js';

const { server, port } = await startServer(0);
const browser = await launchHardwareBrowser();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 720 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/grip-test', route => route.fulfill({ contentType: 'text/html',
    body: '<style>*{margin:0}</style><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>' }));
  await page.goto(`http://127.0.0.1:${port}/grip-test`);
  const clearance = await page.evaluate(async () => {
    const T = await import('three');
    const { createSkydiveRig } = await import('/src/skydive-rig.js');
    const rig = createSkydiveRig(), scene = new T.Scene();
    scene.add(rig.root);
    scene.background = new T.Color(0x788b94);
    const camera = new T.PerspectiveCamera(65, 1200 / 720, .12, 20);
    camera.layers.enableAll();
    const renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(1200, 720);
    document.body.append(renderer.domElement);
    const body = new T.Quaternion();
    const ctl = { planet: { frameOrientation: body, sunDirWorld: new T.Vector3(.2, .85, .4).normalize() },
      posLocal: new T.Vector3(0, 1, 0), quat: camera.quaternion, agl: 700, time: 3,
      phase: 'canopy', dive: 0, airspeed: 16, brakeRight: 0, brakeLeft: 0 };
    const straps = rig.canopy.children.find(o => o.isInstancedMesh && o.geometry.type === 'BoxGeometry');
    const v = new T.Vector3(), a = new T.Vector3(), b = new T.Vector3(), nearest = new T.Vector3();
    const line = new T.Line3(), matrix = new T.Matrix4();
    window.drawGrip = (t, brake = 0) => {
      ctl.deployT = t;
      ctl.brakeRight = brake;
      rig.update(ctl, body, camera.aspect);
      scene.updateMatrixWorld(true);
      renderer.render(scene, camera);
    };
    let riserGap = Infinity, loopGap = Infinity;
    for (const aspect of [1.67, .61]) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      for (const [pitch, yaw] of [[-.35, 0], [.15, 0], [-.2, .9], [.2, -.9], [1.3, 1.6], [-1.3, -1.6]]) {
        camera.rotation.set(pitch, yaw, 0, 'YXZ');
        for (let i = 0; i <= 25; i++) {
          drawGrip(i / 25, i === 25 ? 1 : 0);
          for (const [index, side] of ['left', 'right'].entries()) {
            const h = rig.root.getObjectByName('jump-glove-' + side);
            const uv = h.geometry.attributes.uv;
            // Check the exposed arch against the actual animated fingers. Only
            // the reinforced lower bar belongs inside the curled grasp.
            const toggle = rig.root.getObjectByName('jump-toggle-' + side);
            const rim = toggle.geometry.attributes.position;
            const samples = [];
            for (let k = 0; k < rim.count; k += 40) {
              v.fromBufferAttribute(rim, k);
              if (v.y > .052) samples.push(v.clone().applyMatrix4(toggle.matrixWorld));
            }
            const box = new T.Box3().setFromPoints(samples).expandByScalar(.025);
            for (let j = 0; j < uv.count; j++) {
              if (uv.getX(j) > 0) continue;
              h.getVertexPosition(j, v).applyMatrix4(h.matrixWorld);
              if (box.containsPoint(v)) {
                for (const p of samples) loopGap = Math.min(loopGap, p.distanceTo(v));
              }
            }
            for (let row = 0; row < 2; row++) {
              straps.getMatrixAt(2 * index + row, matrix);
              line.set(a.set(0, -.5, 0).applyMatrix4(matrix), b.set(0, .5, 0).applyMatrix4(matrix));
              for (let j = 0; j < uv.count; j++) {
                if (uv.getX(j) > .08) continue;
                h.getVertexPosition(j, v).applyMatrix4(h.matrixWorld);
                line.closestPointToPoint(v, true, nearest);
                riserGap = Math.min(riserGap, v.distanceTo(nearest));
              }
            }
          }
        }
      }
    }
    camera.aspect = 1200 / 720;
    camera.updateProjectionMatrix();
    camera.rotation.set(-.18, 0, 0);
    return { riser: riserGap, loop: loopGap };
  });
  console.log('Minimum sampled distances in metres', clearance);
  assert.ok(clearance.riser > .020, 'glove must clear the full width of both risers');
  assert.ok(clearance.loop > .006, 'exposed steering arch must clear the fingers');
  const out = process.argv[2];
  if (out) {
    await mkdir(out, { recursive: true });
    for (const [i, t] of [.42, .56, .65, .82, 1].entries()) {
      await page.evaluate(t => drawGrip(t), t);
      await page.screenshot({ path: `${out}/grip-${i}.jpg`, quality: 94 });
    }
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  server.close();
}
