// Air between cloud interaction quantiles: compare the actual production
// helper with an independent fine view integral and direct solar columns.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { atmosphereRenderProfile } from '../src/atmosphere-pass-webgl.js';
import { referenceAir } from './atmosphere-radiance-reference.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const bodies = [
  { R: 6000000, type: 'lush', atmosphere: { pressureBar: 1 }, weatherProfile: { temperatureK: 286 } },
  { R: 300000, type: 'ice', atmosphere: { pressureBar: .15 }, weatherProfile: { temperatureK: 190 } },
  { R: 7000000, type: 'desert', atmosphere: { pressureBar: 2.7 }, weatherProfile: { temperatureK: 410 } },
];
const fixtures = [];
for (const body of bodies) for (const altitude of [1000, 8000]) for (const degrees of [-7, -1, 55]) {
  const { profile, densityScale } = atmosphereRenderProfile(body);
  const mu = altitude === 1000 ? -.1 : .25, angle = degrees * Math.PI / 180;
  const state = { origin: [0, body.R + altitude, 0], direction: [Math.sqrt(1 - mu * mu), mu, 0],
    sun: [Math.cos(angle), Math.sin(angle), 0], distance: 8000, densityScale };
  const coarse = referenceAir(profile, { ...state, steps: 2048 });
  const reference = referenceAir(profile, { ...state, steps: 4096 });
  fixtures.push({ name: `${body.type}/${altitude}/${degrees}`, body, state, coarse, reference });
}
const { server, port } = await startServer(0);
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath(), headless: true });
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route('**/__air-gap', r => r.fulfill({ contentType: 'text/html', body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>' }));
  await page.goto(`http://127.0.0.1:${port}/__air-gap`);
  const result = await page.evaluate(async fixtures => {
    const THREE = await import('three');
    const { AtmospherePass } = await import('/src/atmosphere-pass-webgl.js');
    const { makeCloudVolumeMaterial, disposeCloudNoiseTexture } = await import('/src/clouds-webgl.js');
    const { FullScreenQuad } = await import('/vendor/jsm/postprocessing/Pass.js');
    const renderer = new THREE.WebGLRenderer(); renderer.setSize(1, 1);
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, depthBuffer: false });
    const air = new AtmospherePass(new THREE.PerspectiveCamera());
    const cloud = makeCloudVolumeMaterial({ R: 6000000 }, { rIn: 6000000, rOut: 6030000,
      ox: 0, oy: 0, oz: 0, cov0: .3, cov1: .7 });
    const uniforms = { ...cloud.uniforms, testDirection: { value: new THREE.Vector3() },
      testDistance: { value: 8000 }, testMode: { value: 0 } };
    for (const [name, uniform] of Object.entries(air.material.uniforms)) uniforms['air_' + name] = uniform;
    const prefix = cloud.fragmentShader.slice(0, cloud.fragmentShader.lastIndexOf('void main()'));
    const material = new THREE.ShaderMaterial({ uniforms, defines: cloud.defines,
      vertexShader: 'varying vec3 vDirection,vViewDirection;void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}',
      fragmentShader: prefix + `uniform vec3 testDirection;uniform float testDistance,testMode;
        void main(){
          vec3 light=vec3(0),transmission=vec3(1),cellExt=vec3(0),cellSource=vec3(0);
          float previous=0.0,cellEnd=-1.0;
          for(int i=0;i<16;i++){
            float next=500.0+(testDistance-500.0)*pow(float(i)/15.0,3.0);
            vec3 gapLight,gapTransmission;
            if(i==0)cloudAirGap(air_uCameraLocal,testDirection,previous,next,gapLight,gapTransmission);
            else cloudAirAdvance(air_uCameraLocal,testDirection,previous,next,
              cellEnd,cellExt,cellSource,gapLight,gapTransmission);
            light+=transmission*gapLight;transmission*=gapTransmission;previous=next;
          }
          gl_FragColor=vec4(testMode<0.5?light:transmission,1);
        }`, depthTest: false, depthWrite: false });
    const quad = new FullScreenQuad(material), rows = [];
    for (const { body, state, name } of fixtures) {
      air.setActivePlanet({ ...body, atmoMesh: { visible: true }, posUniv: new THREE.Vector3(),
        _invFrame: new THREE.Quaternion(), sunDirLocal: new THREE.Vector3(...state.sun),
        worldOffsetToLocal: (v, out) => out.copy(v) }, new THREE.Vector3(...state.origin));
      air.material.uniforms.uMultipleEnabled.value = 0;
      uniforms.testDirection.value.fromArray(state.direction);
      const outputs = [];
      for (const mode of [0, 1]) {
        uniforms.testMode.value = mode; renderer.setRenderTarget(target); quad.render(renderer);
        const pixels = new Float32Array(4); renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixels);
        if (pixels[3] !== 1 || !pixels.every(Number.isFinite)) throw Error('Invalid air gap readback');
        outputs.push(Array.from(pixels.slice(0, 3)));
      }
      rows.push({ name, L: outputs[0], T: outputs[1] });
    }
    const glError = renderer.getContext().getError();
    quad.dispose(); material.dispose(); cloud.dispose(); air.dispose(); target.dispose();
    disposeCloudNoiseTexture(); renderer.dispose();
    return { rows, glError };
  }, fixtures);
  const maximum = key => Math.max(...fixtures.flatMap((f, i) => f.reference[key].map((v, c) =>
    Math.abs(v - result.rows[i][key][c]))));
  const convergence = Math.max(...fixtures.flatMap(f => ['L', 'T'].flatMap(key =>
    f.reference[key].map((v, c) => Math.abs(v - f.coarse[key][c])))));
  const radianceError = maximum('L'), transmissionError = maximum('T');
  await mkdir('test-results/b4-air-gap', { recursive: true });
  await writeFile('test-results/b4-air-gap/report.json', JSON.stringify({ fingerprint:
    await evidenceFingerprint('tools/b4airgaptest.js'), fixtures, ...result, errors,
    convergence, radianceError, transmissionError }, null, 2));
  console.log({ cases: fixtures.length, convergence, radianceError, transmissionError, errors });
  assert.deepEqual(errors, []); assert.equal(result.glError, 0);
  assert.ok(convergence < .00002, 'independent reference must converge');
  assert.ok(radianceError < .002 && transmissionError < .0005, 'bounded partial air cells');
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
