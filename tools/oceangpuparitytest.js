import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const out = `test-results/ocean-gpu-parity/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const fingerprint = await evidenceFingerprint('tools/oceangpuparitytest.js');
const { server, port } = await startServer(0);
const browser = await launchHardwareBrowser({ headless: true });
const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
try {
  // Isolated numerical kernel, not a normal-player visual acceptance fixture.
  await page.route('**/ocean-gpu-fixture', (route) => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><title>Ocean GLSL numerical parity</title>' }));
  await page.goto(`http://127.0.0.1:${port}/ocean-gpu-fixture`);
  const result = await page.evaluate(async () => {
    const THREE = await import('/vendor/three.module.js');
    const wave = await import('/src/ocean-wave-field.js');
    const tidal = await import('/src/ocean-tidal-event.js');
    const detail = await import('/src/ocean-detail-frame.js');
    const wake = await import('/src/ocean-wake-packet.js');
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(1, 1);
    renderer.toneMapping = THREE.NoToneMapping;
    const gl = renderer.getContext();
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('Float render targets unavailable.');
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType,
      format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      depthBuffer: false, stencilBuffer: false });
    const scene = new THREE.Scene();
    const camera = new THREE.Camera();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    mesh.frustumCulled = false;
    scene.add(mesh);
    const rows = [];
    const vector = (a) => new THREE.Vector3(...a);
    const output = (sample) => [sample.height, sample.gradient.x, sample.gradient.y, sample.gradient.z];
    const render = (material) => {
      mesh.material = material;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      const pixels = new Float32Array(4);
      renderer.readRenderTargetPixels(target, 0, 0, 1, 1, pixels);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw new Error(`WebGL error ${error}`);
      return Array.from(pixels);
    };
    const material = (source, expression, uniforms) => new THREE.ShaderMaterial({
      uniforms, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `precision highp float;\nuniform vec3 uPosition;\nuniform float uFootprint;\nuniform float uDepth;\n${source}\nvoid main() { gl_FragColor = ${expression}; }`,
    });
    const record = (kind, label, expected, actual, tolerance) => {
      const differences = expected.map((value, i) => Math.abs(value - actual[i]));
      rows.push({ kind, label, expected, actual, differences, tolerance,
        pass: actual.every(Number.isFinite) && differences.every((v, i) => v <= tolerance[i]) });
    };
    const field = wave.createOceanWaveField('gpu-parity-fixed-v1', { period: 12.3 });
    const waveUniforms = { uPosition: { value: new THREE.Vector3() }, uFootprint: { value: 4 },
      uOceanModes: { value: field.modes.map((m) => new THREE.Vector4(...m.axis, m.k)) },
      uOceanPhases: { value: [] }, uOceanHeight: { value: 6.7 },
      uOceanNormalization: { value: field.normalization } };
    const waveMaterial = material(wave.oceanWaveGLSL, 'oceanWaveField(uPosition, uFootprint)', waveUniforms);
    const position = { x: 6000000.125, y: -2356000.375, z: 4567000.875 };
    const anchors = [position, { x: position.x + 1024, y: position.y - 256, z: position.z + 512 },
      { x: position.x - 4096, y: position.y + 4096, z: position.z - 2048 }];
    for (const seconds of [0, 12345.678, 1e9 + 0.125]) {
      for (const footprint of [0, 4, 144]) {
        for (let i = 0; i < anchors.length; i++) {
          const anchor = anchors[i];
          waveUniforms.uPosition.value.set(position.x - anchor.x, position.y - anchor.y, position.z - anchor.z);
          waveUniforms.uFootprint.value = footprint;
          waveUniforms.uOceanPhases.value = wave.oceanWavePhases(field, anchor, seconds).map((p) => new THREE.Vector2(...p));
          record('wave', `time=${seconds}, footprint=${footprint}, anchor=${i}`,
            output(wave.sampleOceanWaveField(field, position, seconds, { significantHeight: 6.7, footprint })),
            render(waveMaterial), [0.001, 0.0001, 0.0001, 0.0001]);
        }
      }
    }
    const event = tidal.createOceanTidalEvent({ normal: [0.8143777921, 0.576427798, -0.0672294979],
      height: 282.0551, period: 406.711461, epoch: 27027.143848 }, { radius: 6000000, gravity: 13.4073 });
    const tidalUniforms = { uPosition: { value: new THREE.Vector3() }, uDepth: { value: 2000 },
      uTidalAxis: { value: vector(event.axis) }, uTidalSide: { value: vector(event.side) },
      uTidalUp: { value: vector(event.up) }, uTidalOffset: { value: new THREE.Vector3() },
      uTidalShape: { value: new THREE.Vector4() }, uTidalDepthRatio: { value: event.depthRatio } };
    const tidalMaterial = material(tidal.oceanTidalEventGLSL, 'oceanTidalEvent(uPosition, uDepth)', tidalUniforms);
    for (const cycle of [0, 1000000]) {
      for (const phase of [0, 0.000001, 0.5, 0.999999]) {
        const seconds = event.epoch + (cycle + phase) * event.period;
        for (const [along, lateral] of [[0, 0], [0.3, 0], [-1.2, 0.5], [5.5, 0], [6, 0], [0, 2.5], [0, 3]]) {
          const p = Object.fromEntries(['x', 'y', 'z'].map((key, i) => [key,
            event.up[i] * event.radius + event.axis[i] * along * event.width + event.side[i] * lateral * event.lateralWidth]));
          for (const depth of [0, 0.9, 2000]) {
            const anchor = { x: p.x + 1024, y: p.y - 512, z: p.z + 256 };
            const u = tidal.oceanTidalEventUniforms(event, anchor, seconds);
            tidalUniforms.uTidalOffset.value.fromArray(u.offset);
            tidalUniforms.uTidalShape.value.fromArray(u.shape);
            tidalUniforms.uDepth.value = depth;
            tidalUniforms.uPosition.value.set(p.x - anchor.x, p.y - anchor.y, p.z - anchor.z);
            record('tidal', `cycle=${cycle}, phase=${phase}, along=${along}, lateral=${lateral}, depth=${depth}`,
              output(tidal.sampleOceanTidalEvent(event, p, seconds, { depth })), render(tidalMaterial),
              [0.003, 0.0001, 0.0001, 0.0001]);
          }
        }
      }
    }
    // Actual generated detail functions sample a deterministic nearest/repeat
    // texture, compared against independent JS texture addressing and mixing.
    const texels = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < texels.length; i++) texels[i] = (i * 73 + Math.floor(i / 7) * 31) % 256;
    const texture = new THREE.DataTexture(texels, 16, 16, THREE.RGBAFormat);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = texture.magFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    const detailFrame = detail.createOceanDetailFrame(0.0397);
    const fract = (v) => v - Math.floor(v);
    const lookup = (x, y, c) => texels[(Math.floor(fract(y) * 16) * 16 + Math.floor(fract(x) * 16)) * 4 + c] / 255;
    for (let channel = 0; channel < detailFrame.channels.length; channel++) {
      const uniforms = { uPosition: { value: new THREE.Vector3() }, uDetailTex: { value: texture },
        uOceanDetailOffsets: { value: [] } };
      const name = detailFrame.channels[channel].name;
      const shader = material(`uniform sampler2D uDetailTex;\n${detail.oceanDetailGLSL(detailFrame)}`,
        channel < 6 ? `vec4(ocean${name}(uPosition, vec2(0.123, -0.987)))`
          : `vec4(fract(ocean${name}(uPosition, vec2(0.123, -0.987))), 0.0, 0.0)`, uniforms);
      for (let i = 0; i < anchors.length; i++) {
        const anchor = anchors[i];
        uniforms.uPosition.value.set(position.x - anchor.x, position.y - anchor.y, position.z - anchor.z);
        uniforms.uOceanDetailOffsets.value = detail.oceanDetailOffsets(detailFrame, anchor).map((uv) => new THREE.Vector4(...uv));
        const uv = detail.oceanDetailCoordinates(detailFrame, channel, position,
          detail.oceanDetailOffsets(detailFrame, { x: 0, y: 0, z: 0 }), [0.123, -0.987]);
        const value = Math.max(0, Math.min(1, 0.5 + (lookup(uv[0], uv[1], 0) * 0.65 + lookup(uv[2], uv[3], 1) * 0.35 - 0.5) * 2));
        record('detail', `${name}, anchor=${i}`,
          channel < 6 ? [value, value, value, value] : [fract(uv[0]), fract(uv[1]), 0, 0], render(shader),
          channel < 6 ? [0.00001, 0.00001, 0.00001, 0.00001] : [0.0005, 0.0005, 0.00001, 0.00001]);
      }
      shader.dispose();
    }
    const wakeUniforms = { uPosition: { value: new THREE.Vector3() }, uDepth: { value: 8.8 } };
    const wakeMaterial = material(wake.oceanWakePacketGLSL + `
      vec4 wakeProbe() {
        OceanWakePacket p = oceanWakePacket(uPosition.x, uPosition.y, uPosition.z, uDepth, 0.82);
        return vec4(p.armEnvelope, p.coreEnvelope, p.centerEnvelope, p.armCenter);
      }`, 'wakeProbe()', wakeUniforms);
    for (const age of [0, 0.7, 2.6, 5, 7.99, 8]) {
      for (const along of [-40, -12, -2, 8, 19]) {
        const center = wake.sampleOceanWakePacket({ along, lateral: 0, age, speed: 8.8 }).armCenter;
        for (const lateral of [0, center, -center, center + 4, center + 16]) {
          wakeUniforms.uPosition.value.set(along, lateral, age);
          const p = wake.sampleOceanWakePacket({ along, lateral, age, speed: 8.8, strength: 0.82 });
          record('wake', `age=${age}, along=${along}, lateral=${lateral}`,
            [p.armEnvelope, p.coreEnvelope, p.centerEnvelope, p.armCenter], render(wakeMaterial),
            [0.00001, 0.00001, 0.00001, 0.0001]);
        }
      }
    }
    wakeMaterial.dispose();
    const maxima = Object.fromEntries(['wave', 'tidal', 'detail', 'wake'].map((kind) => [kind,
      [0, 1, 2, 3].map((i) => Math.max(...rows.filter((r) => r.kind === kind).map((r) => r.differences[i])))]));
    texture.dispose(); waveMaterial.dispose(); tidalMaterial.dispose(); mesh.geometry.dispose(); target.dispose(); renderer.dispose();
    return { gpu, rendererBackend: 'webgl2', scope: 'numerical kernels only; not visual acceptance', maxima, rows };
  });
  const endFingerprint = await evidenceFingerprint('tools/oceangpuparitytest.js');
  const stableSource = endFingerprint.sourceDigest === fingerprint.sourceDigest;
  const pass = stableSource && errors.length === 0 && result.rows.every((row) => row.pass)
    && !/SwiftShader|llvmpipe|software/i.test(result.gpu);
  await writeFile(`${out}/report.json`, JSON.stringify({ status: pass ? 'pass' : 'fail', fingerprint,
    endFingerprint, stableSource, errors, ...result }, null, 2));
  console.log(JSON.stringify({ status: pass ? 'pass' : 'fail', gpu: result.gpu,
    maxima: result.maxima, failed: result.rows.filter((row) => !row.pass), errors, stableSource }));
  assert.ok(pass, `Ocean GPU parity failed; inspect ${out}/report.json`);
} finally {
  await browser.close();
  server.close();
}
