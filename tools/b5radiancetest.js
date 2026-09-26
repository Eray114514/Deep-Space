import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { atmosphereRenderProfile } from '../src/atmosphere-pass-webgl.js';
import { columnFixtures } from './atmosphere-reference.js';
import { referenceAir } from './atmosphere-radiance-reference.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const bodies = [
  { R: 6000000, type: 'lush', atmosphere: { pressureBar: 1 }, weatherProfile: { temperatureK: 286 } },
  { R: 300000, type: 'ice', atmosphere: { pressureBar: 0.15 }, weatherProfile: { temperatureK: 190 } },
  { R: 7000000, type: 'desert', atmosphere: { pressureBar: 2.7 }, weatherProfile: { temperatureK: 410 } },
];
const fixtures = bodies.flatMap((body) => {
  const { profile, densityScale } = atmosphereRenderProfile(body);
  return columnFixtures(profile).filter((f) => ['zenith', 'low-oblique', 'orbit-tangent-8000', 'orbit-nadir'].includes(f.name))
    .flatMap((ray) => [-6, -1, 0, 5, 35, 89].map((degrees) => {
      const angle = degrees * Math.PI / 180;
      const state = { origin: [0, ray.radius, 0], direction: [Math.sqrt(1 - ray.mu ** 2), ray.mu, 0],
        sun: [Math.cos(angle), Math.sin(angle), 0], distance: ray.distance, densityScale };
      return { body, name: `${body.type}/${ray.name}/${degrees}`, state, reference: referenceAir(profile, state) };
    }));
});
const { server, port } = await startServer(0);
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined, headless: true });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/__b5-radiance', (r) => r.fulfill({ contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>' }));
  await page.goto(`http://127.0.0.1:${port}/__b5-radiance`);
  const result = await page.evaluate(async (fixtures) => {
    const THREE = await import('three');
    const { AtmospherePass } = await import('/src/atmosphere-pass-webgl.js');
    const { createMultipleScatteringLut } = await import('/src/atmosphere-multiple-scattering.js');
    const { FullScreenQuad } = await import('/vendor/jsm/postprocessing/Pass.js');
    const renderer = new THREE.WebGLRenderer(); renderer.setSize(1, 1);
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false });
    const pass = new AtmospherePass(new THREE.PerspectiveCamera());
    const prefix = pass.material.fragmentShader.slice(0, pass.material.fragmentShader.lastIndexOf('void main()'));
    const material = new THREE.ShaderMaterial({ uniforms: { ...pass.material.uniforms,
      testDirection: { value: new THREE.Vector3() }, testDistance: { value: 1 }, testMode: { value: 0 } },
    vertexShader: pass.material.vertexShader, depthTest: false, depthWrite: false,
    fragmentShader: prefix + `uniform vec3 testDirection; uniform float testDistance,testMode;
      void main(){vec3 L,T;airIntegrate(uCameraLocal,testDirection,0.0,testDistance,L,T);
        gl_FragColor=vec4(testMode<0.5?L:T,1);}` });
    const quad = new FullScreenQuad(material), u = material.uniforms;
    const cases = [];
    for (const { body, state } of fixtures) {
      const p = { ...body, atmoMesh: { visible: true }, posUniv: new THREE.Vector3(),
        _invFrame: new THREE.Quaternion(), sunDirLocal: new THREE.Vector3(...state.sun),
        worldOffsetToLocal: (v, out) => out.copy(v) };
      pass.setActivePlanet(p, new THREE.Vector3(...state.origin));
      u.uMultipleEnabled.value = 0;
      u.testDirection.value.fromArray(state.direction); u.testDistance.value = state.distance;
      const outputs = [];
      for (const mode of [0, 1]) {
        u.testMode.value = mode; renderer.setRenderTarget(target); quad.render(renderer);
        const data = new Float32Array(4); renderer.readRenderTargetPixels(target, 0, 0, 1, 1, data);
        outputs.push(Array.from(data.slice(0, 3)));
      }
      cases.push({ L: outputs[0], T: outputs[1] });
    }
    const multiple = [], finalRgb = [];
    for (const type of ['lush', 'ice', 'desert']) {
      const { body, state } = fixtures.find((f) => f.body.type === type);
      pass.setActivePlanet({ ...body, atmoMesh: { visible: true }, posUniv: new THREE.Vector3(),
        _invFrame: new THREE.Quaternion(), sunDirLocal: new THREE.Vector3(...state.sun),
        worldOffsetToLocal: (v, out) => out.copy(v) }, new THREE.Vector3(...state.origin));
      const regular = createMultipleScatteringLut(renderer, pass.material.uniforms);
      const dense = createMultipleScatteringLut(renderer, pass.material.uniforms, { directions: 512, steps: 96 });
      const read = (rt) => { const data = new Uint16Array(32*32*4); renderer.readRenderTargetPixels(rt,0,0,32,32,data);
        return Array.from(data, (h) => THREE.DataUtils.fromHalfFloat(h)); };
      multiple.push({ type, actual: read(regular), reference: read(dense) });
      for(const fixture of fixtures.filter((f)=>f.body.type===type)) {
        const {state}=fixture;
        u.uCameraLocal.value.fromArray(state.origin);u.uSunDirection0.value.fromArray(state.sun);
        u.testDirection.value.fromArray(state.direction);u.testDistance.value=state.distance;
        u.uMultipleEnabled.value=1;u.testMode.value=0;
        const outputs=[];
        for(const lut of [regular,dense]) {
          u.tMultipleScattering.value=lut.texture;renderer.setRenderTarget(target);quad.render(renderer);
          const data=new Float32Array(4);renderer.readRenderTargetPixels(target,0,0,1,1,data);outputs.push(Array.from(data.slice(0,3)));
        }
        const error=Math.max(...outputs[0].map((x,c)=>Math.abs(x-outputs[1][c])/(0.002+Math.abs(outputs[1][c]))));
        finalRgb.push({name:fixture.name,actual:outputs[0],reference:outputs[1],error});
      }
      u.uMultipleEnabled.value=0;u.tMultipleScattering.value=null;
      regular.dispose(); dense.dispose();
    }
    const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    if (gl.getError() !== 0) throw Error('WebGL readback/draw error');
    pass.dispose(); material.dispose(); quad.dispose(); target.dispose(); renderer.dispose();
    return { cases, multiple, finalRgb, gpu };
  }, fixtures);
  assert.deepEqual(errors, []);
  const cases = result.cases.map((actual, i) => {
    const { name, reference } = fixtures[i];
    const rgbError = Math.max(...actual.L.map((x, c) => Math.abs(x-reference.L[c])/(0.002+Math.abs(reference.L[c]))));
    const transmissionError = Math.max(...actual.T.map((x,c)=>Math.abs(x-reference.T[c])));
    return { name, actual, reference, rgbError, transmissionError };
  });
  const multiple = result.multiple.map(({ type, actual, reference }) => {
    const errors = actual.filter((_,i)=>i%4!==3).map((x,i)=> {
      const offset=Math.floor(i/3)*4+i%3;
      return Math.abs(x-reference[offset])/(0.002+Math.abs(reference[offset]));
    }).sort((a,b)=>a-b);
    return { type, maxRelative: errors.at(-1), p95Relative: errors[Math.floor(errors.length*0.95)],
      finite: actual.every(Number.isFinite), maximum: Math.max(...actual.filter((_,i)=>i%4!==3)) };
  });
  await mkdir('test-results/b5', { recursive: true });
  await writeFile('test-results/b5/radiance.json', JSON.stringify({ fingerprint: await evidenceFingerprint('tools/b5radiancetest.js'),
    gpu: result.gpu, cases, multiple, finalRgb: result.finalRgb, errors,
    scope: 'Single-scattering RGB vs independent dense CPU integration; isotropic higher-order closure quadrature vs 512-direction/96-step GPU refinement, not independent path tracing.' }, null, 2));
  console.log('Worst single scattering:', [...cases].sort((a,b)=>b.rgbError-a.rgbError).slice(0,8));
  console.log('Higher order closure convergence:', multiple);
  console.log('Final RGB refinement maximum:', Math.max(...result.finalRgb.map((c)=>c.error)));
  assert.ok(result.finalRgb.every((c)=>c.error<0.05), 'final RGB multiple-scattering error propagation');
  assert.ok(cases.every((c)=>c.rgbError<0.05 && c.transmissionError<0.01), 'single scattering RGB/T error');
  assert.ok(multiple.every((c)=>c.finite && c.p95Relative<0.05 && c.maxRelative<0.25), 'higher-order angular/segment quadrature');
} finally {
  await browser?.close(); await new Promise((resolve) => server.close(resolve));
}
