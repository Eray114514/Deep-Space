// Actual production view integration against an independently accumulated
// double-precision midpoint reference of WebGL-read-back extinction samples.
// This is an optical sampling gate, not a visual acceptance test.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const fingerprint = await evidenceFingerprint('tools/b4mediumconvergencetest.js');
const output = `test-results/b4-medium/${fingerprint.sourceDigest.slice(0, 12)}`;
await mkdir(output, { recursive: true });
const { server, port } = await startServer(0);
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath(), headless: true });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&freeze=1&time=9.5&quality=ultra&vclouds=1&post=1&nolock=1`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 150000 });
  await page.waitForFunction(()=>[0,2,4].every(i=>{
    const p=NMS._planet(i);return p.weatherStream?.ready
      && Math.abs(p.cloudSpeciesTex.userData.hours-p.weatherHours)<1/300;
  }),null,{timeout:60000});
  const records = await page.evaluate(() => {
    const THREE = NMS._THREE, renderer = NMS._renderer;
    const geometry = new THREE.PlaneGeometry(2, 2), scene = new THREE.Scene(), camera = new THREE.Camera();
    const vertex = `uniform vec3 uRay; varying vec3 vDirection,vViewDirection;
      void main(){vDirection=uRay;vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}`;
    const referenceTarget = new THREE.WebGLRenderTarget(4096, 1, { type: THREE.FloatType, depthBuffer: false });
    const viewTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false });
    const savedTarget = renderer.getRenderTarget(), results = [];
    // Independent double-precision geometry. No shader sphereHits reuse.
    const intersect = (o, d, r) => {
      const b = o.dot(d), discriminant = b * b - o.lengthSq() + r * r;
      return discriminant < 0 ? null : [-b - Math.sqrt(discriminant), -b + Math.sqrt(discriminant)];
    };
    for (const index of [0, 2, 4]) {
      const p = NMS._planet(index), source = p.volCloudMat;
      const prefix = source.fragmentShader.slice(0, source.fragmentShader.lastIndexOf('void main()'));
      const shared = { ...source.uniforms, uRay: { value: new THREE.Vector3() },
        uCameraLocal: { value: new THREE.Vector3() }, uOrigin: { value: new THREE.Vector3() },
        uRange: { value: new THREE.Vector2() }, uCount: { value: 4096 },
        uDepthReady: { value: 0 }, uEngage: { value: 1 }, uFrame: { value: 0 },
        uSunEnergy: { value: 0 }, uSecondarySunEnergy: { value: 0 }, air_uEnabled: { value: 0 } };
      // The genuine main() computes geometry, steps, jitter and attenuation.
      const view = new THREE.ShaderMaterial({ defines: { ...source.defines }, uniforms: shared,
        vertexShader: vertex, fragmentShader: 'uniform vec3 uRay;\n' + source.fragmentShader
          .replace('gl_FragColor = vec4(correction * uEngage, alpha);', 'gl_FragColor = vec4(1.0-T,float(STEPS),dt,1.0);'),
        depthTest: false, depthWrite: false });
      // Reference contains no integration loop and no production march logic.
      const reference = new THREE.ShaderMaterial({ defines: { ...source.defines }, uniforms: shared,
        vertexShader: vertex, fragmentShader: prefix + `
          uniform vec3 uRay,uOrigin; uniform vec2 uRange; uniform float uCount;
          void main(){float t=mix(uRange.x,uRange.y,(gl_FragCoord.x)/uCount);
            float sigma=cloudExtinctionAt(uOrigin+uRay*t,0.0);
            gl_FragColor=vec4(sigma,0,0,1);}`, depthTest: false, depthWrite: false });
      const mesh = new THREE.Mesh(geometry, reference); scene.add(mesh);
      for (let i = 0; i < 24; i++) {
        const y = 1 - 2 * (i + 0.5) / 24, a = i * 2.399963229728653;
        const radial = new THREE.Vector3(Math.cos(a) * Math.sqrt(1-y*y), y, Math.sin(a) * Math.sqrt(1-y*y));
        const east = new THREE.Vector3().crossVectors(radial, new THREE.Vector3(0,1,0)).normalize();
        for (const [height, mu] of [[p.volCloudBand.rOut-p.R+50, 1],
          [p.volCloudBand.rOut-p.R+50, 0.078], [4500, 0], [11000, 0.15]]) {
          const origin = radial.clone().multiplyScalar(p.R+height);
          const ray = east.clone().multiplyScalar(Math.sqrt(1-mu*mu)).addScaledVector(radial,-mu).normalize();
          const outer = intersect(origin,ray,p.volCloudBand.rOut);
          if (!outer || outer[1] <= 0) continue;
          let start = Math.max(0,outer[0]), end = outer[1];
          const ground = intersect(origin,ray,source.uniforms.uGroundR.value);
          if (ground?.[0] > 0) end = Math.min(end,ground[0]);
          if (end <= start) continue;
          shared.uOrigin.value.copy(origin); shared.uCameraLocal.value.copy(origin);
          shared.uRay.value.copy(ray); shared.uRange.value.set(start,end);
          const values = [];
          for (const count of [1024,2048,4096]) {
            shared.uCount.value = count;
            referenceTarget.setSize(count,1); renderer.setRenderTarget(referenceTarget);
            mesh.material = reference; renderer.render(scene,camera);
            const pixels = new Float32Array(count*4);
            renderer.readRenderTargetPixels(referenceTarget,0,0,count,1,pixels);
            let opticalDepth = 0;
            for(let k=0;k<count;k++) {
              if(pixels[k*4+3]!==1 || !Number.isFinite(pixels[k*4])) throw Error('Invalid reference readback');
              opticalDepth += pixels[k*4] * (end-start)/count;
            }
            values.push({ count, opacity: -Math.expm1(-opticalDepth), opticalDepth });
          }
          mesh.material = view; renderer.setRenderTarget(viewTarget); renderer.clear(); renderer.render(scene,camera);
          const pixel = new Float32Array(4); renderer.readRenderTargetPixels(viewTarget,0,0,1,1,pixel);
          if(!pixel.every(Number.isFinite)) throw Error('Invalid view readback');
          results.push({ index, seed:p.seed, height, mu, column:i, range:[start,end], values,
            opacity:pixel[3]===1?pixel[0]:0, steps:pixel[1], stepMeters:pixel[2] });
        }
      }
      scene.remove(mesh); reference.dispose(); view.dispose();
    }
    renderer.setRenderTarget(savedTarget);
    geometry.dispose(); referenceTarget.dispose(); viewTarget.dispose();
    if(renderer.getContext().getError()!==0) throw Error('WebGL error');
    return results;
  });
  // Thresholds are stated before tuning: independently doubled reference must
  // settle, occupied cases cannot disappear, and individual long rays count.
  const metrics = { cases: records.length, occupied: 0, maximumReferenceError: 0,
    meanViewError: 0, maximumViewError: 0, failures: [] };
  for(const r of records) {
    const referenceError = Math.abs(r.values[2].opacity-r.values[1].opacity);
    const viewError = Math.abs(r.opacity-r.values[2].opacity);
    metrics.maximumReferenceError = Math.max(metrics.maximumReferenceError,referenceError);
    metrics.maximumViewError = Math.max(metrics.maximumViewError,viewError);
    metrics.meanViewError += viewError/records.length;
    if(r.values[2].opacity>0.1) metrics.occupied++;
    if(referenceError>0.01 || viewError>0.05) metrics.failures.push({ index:r.index,column:r.column,height:r.height,mu:r.mu,referenceError,viewError });
  }
  await writeFile(`${output}/report.json`,JSON.stringify({ fingerprint,metrics,records,errors },null,2)+'\n');
  console.log(JSON.stringify({ output,metrics,errors },null,2));
  assert.deepEqual(errors,[]);
  assert.ok(metrics.occupied>24,'Real nonempty production rays required');
  assert.ok(metrics.maximumReferenceError<0.01,'Reference must converge before it can judge production');
  assert.ok(metrics.meanViewError<0.01 && metrics.maximumViewError<0.05,'Production opacity must match reference on every ray');
} finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
