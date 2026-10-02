import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchBrowser, launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

// Numerical GPU attribution; the separate player test still owns whole-page QA.
const out = 'test-results/far-flora-precision';
await mkdir(out, { recursive: true });
const fingerprint = await evidenceFingerprint('tools/farfloragputest.js');
const { server, port } = await startServer(0);
let browser;
const errors = [];
try {
  browser = process.env.FAR_FLORA_HARDWARE === '1'
    ? await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined })
    : await launchBrowser();
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
    else if (message.text().startsWith('Far-flora GPU:')) console.log(message.text());
  });
  await page.route('**/far-flora-precision-fixture.html', route => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>' }));
  await page.goto(`http://127.0.0.1:${port}/far-flora-precision-fixture.html`);
  const report = await page.evaluate(async () => {
    const T = await import('three');
    const { FarFlora } = await import('/src/farflora.js');
    const { farFloraPrecisionFixture } = await import('/tools/far-flora-precision-fixture.js');
    const renderer = new T.WebGLRenderer({ logarithmicDepthBuffer: true });
    const gl = renderer.getContext(), adapter = gl.getExtension('WEBGL_debug_renderer_info');
    const camera = new T.PerspectiveCamera(62, 1, 0.12, 1.2e11);
    camera.quaternion.setFromEuler(new T.Euler(-0.21, 0.37, 0.11));
    const inverseView = camera.quaternion.clone().invert();
    const points = new T.BufferGeometry();
    // Three coincident probe vertices rasterise one texel per instance. The
    // measurement is constant over that diagnostic triangle.
    points.setAttribute('position', new T.Float32BufferAttribute([0,0,0, 0,0,0, 0,0,0], 3));
    const material = new T.ShaderMaterial({ glslVersion: T.GLSL3, depthTest: false, depthWrite: false,
      blending: T.NoBlending, toneMapped: false,
      uniforms: { uCount: { value: 1 }, uCamL: { value: new T.Vector3() }, uProbe: { value: new T.Vector3() } },
      vertexShader: `uniform float uCount; uniform vec3 uCamL,uProbe;
        flat out vec4 vMeasured;
        void main() {
          vec4 base=instanceMatrix*vec4(position,1.0);
          vec4 point=instanceMatrix*vec4(position+uProbe,1.0);
          vMeasured=vec4((modelViewMatrix*point).xyz,distance(base.xyz,uCamL));
          vec2 corner=gl_VertexID==0?vec2(-.5,-1):gl_VertexID==1?vec2(.5,-1):vec2(0,1);
          gl_Position=vec4(2.0*(float(gl_InstanceID)+.5+corner.x)/uCount-1.0,corner.y,0,1);
        }`,
      fragmentShader: 'flat in vec4 vMeasured; out vec4 measured; void main(){measured=vMeasured;}' });
    const target = new T.WebGLRenderTarget(1, 1, { type: T.FloatType, depthBuffer: false });
    const directions = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],
      [1,1,1],[-1,-1,-1],[-2963,5053,134],[1,-2,-3]];
    let samples = 0, maxPositionError = 0, maxDistanceError = 0;
    let failure = null;
    try {
      for (const profile of ['flat', 'relief']) for (const radius of [286000, 6000000, 20000000]) {
        console.log(`Far-flora GPU: ${profile}, R=${radius}`);
        const fixture = farFloraPrecisionFixture(radius, profile);
        const p = fixture.planet, ff = new FarFlora({ streamBudgetMs: 0 });
        try {
          for (const direction of directions) {
            ff.clear();
            const cam = new T.Vector3(...direction).normalize();
            cam.multiplyScalar(radius + p.height(cam, p.fullMaxFreq) + 400);
            p.group.quaternion.setFromEuler(new T.Euler(0.31, -0.27, 0.41));
            p.group.position.copy(cam).applyQuaternion(p.group.quaternion).negate();
            ff.update(p, cam, 400);
            const firstAnchor = [...ff.anchorK];
            const firstKey = ff.job.key;
            const distantKey = [...ff.targetKeys].sort((a, b) => {
              const distance = key => new T.Vector3(...key.split(':').map(Number))
                .distanceToSquared(new T.Vector3(...firstAnchor));
              return distance(b) - distance(a);
            })[0];
            const reference = [new Map(), new Map()];
            for (const key of [firstKey, distantKey]) {
              fixture.reset();
              const tile = ff.buildTile(p, key);
              ff.tiles.set(key, tile);
              for (const species of [0, 1]) for (let i = 0; i < tile[`n${species}`]; i++) {
                const identity = tile[`m${species}`].subarray(i * 16, i * 16 + 12).join(':');
                if (!reference[species].has(identity)) reference[species].set(identity, []);
                reference[species].get(identity).push(fixture.expected[species][i].clone());
              }
            }
            for (const anchor of [firstAnchor, distantKey.split(':').map(Number)]) {
              ff.anchorK = anchor;
              ff.repack();
              for (const source of ff.meshes) {
                const species = ff.meshes.indexOf(source), count = source.count;
                if (!count) continue;
                const scene = new T.Scene(), root = new T.Group();
                root.position.copy(p.group.position); root.quaternion.copy(p.group.quaternion); scene.add(root);
                const mesh = new T.InstancedMesh(points, material, 1);
                mesh.instanceMatrix = source.instanceMatrix; mesh.count = count;
                mesh.position.copy(source.position); mesh.frustumCulled = false; root.add(mesh);
                material.uniforms.uCount.value = count;
                material.uniforms.uCamL = ff.uCamL;
                target.setSize(count, 1);
                const pixels = new Float32Array(count * 4);
                for (const tip of [0, 5]) {
                  material.uniforms.uProbe.value.set(0, tip, 0);
                  renderer.setRenderTarget(target); renderer.clear(); renderer.render(scene, camera);
                  renderer.readRenderTargetPixels(target, 0, 0, count, 1, pixels);
                  const error = gl.getError();
                  if (error) throw Error(`GPU probe GL error ${error}`);
                  const unmatched = new Map([...reference[species]].map(([identity, values]) => [identity, [...values]]));
                  for (let i = 0; i < count; i++) {
                    const matrix = source.instanceMatrix.array;
                    const identity = matrix.subarray(i * 16, i * 16 + 12).join(':');
                    const candidates = unmatched.get(identity);
                    const submitted = new T.Vector3().fromArray(matrix, i * 16 + 12).add(source.position);
                    candidates.sort((a, b) => submitted.distanceToSquared(a) - submitted.distanceToSquared(b));
                    const canonical = candidates.shift();
                    const localTip = new T.Vector3(matrix[i * 16 + 4], matrix[i * 16 + 5], matrix[i * 16 + 6]).multiplyScalar(tip);
                    const expectedView = canonical.clone().add(localTip).sub(cam)
                      .applyQuaternion(p.group.quaternion).applyQuaternion(inverseView);
                    const measured = new T.Vector3().fromArray(pixels, i * 4);
                    const positionError = measured.distanceTo(expectedView);
                    const distanceError = Math.abs(pixels[i * 4 + 3] - canonical.distanceTo(cam));
                    if (!Number.isFinite(positionError + distanceError)) throw Error('Non-finite GPU sample.');
                    maxPositionError = Math.max(maxPositionError, positionError);
                    maxDistanceError = Math.max(maxDistanceError, distanceError);
                    samples++;
                    if (positionError >= 0.002 || distanceError >= 0.002) {
                      throw Error(`GPU precision exceeded: R=${radius}, ${profile}, tip=${tip}, position=${positionError}, distance=${distanceError}`);
                    }
                  }
                }
                mesh.dispose();
              }
            }
          }
        } finally { ff.clear(); fixture.geometry.dispose(); }
      }
    } catch (error) { failure = String(error); }
    finally { renderer.setRenderTarget(null); target.dispose(); material.dispose(); points.dispose(); renderer.dispose(); }
    return { samples, maxPositionError, maxDistanceError, failure,
      gpu: adapter ? gl.getParameter(adapter.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
  });
  const finalFingerprint = await evidenceFingerprint('tools/farfloragputest.js');
  const reportPath = `${out}/${process.env.FAR_FLORA_HARDWARE === '1' ? 'hardware' : 'swiftshader'}-gpu.json`;
  await writeFile(reportPath, JSON.stringify({ fingerprint,
    stableSource: fingerprint.sourceDigest === finalFingerprint.sourceDigest,
    finalSourceDigest: finalFingerprint.sourceDigest, report, errors,
    scope: 'GPU transform/distance attribution; 60 poses, two origins, bases/tips; not player/performance acceptance' }, null, 2));
  console.log(JSON.stringify(report));
  assert.deepEqual(errors, [], errors.join('\n'));
  assert.equal(report.failure, null);
  assert.ok(report.samples > 100000);
  assert.ok(report.maxPositionError < 0.002, 'GPU camera-relative tree placement must remain within 2 mm.');
  assert.ok(report.maxDistanceError < 0.002, 'GPU fade distance must remain within 2 mm.');
  console.log(`PASS: far-flora GPU placement/fade distance; ${reportPath}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
