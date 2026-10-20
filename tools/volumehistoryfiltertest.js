import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const out = `test-results/volume-filter/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const before = await evidenceFingerprint('tools/volumehistoryfiltertest.js');
const reference = execFileSync('git', ['show', '9ca1a18:src/volumetric-pass-webgl.js']);
await writeFile(`${out}/reference-volumetric-pass-webgl.js`, reference);
const { server, port } = await startServer(0);
const errors = [], warnings = [];
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  const page = await browser.newPage({ viewport: { width: 800, height: 520 } });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
    if (message.type() === 'warning') warnings.push(message.text());
  });
  await page.route('**/tools/volume-filter.html', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><link rel="icon" href="data:,"><title>Volume history support</title>'
    + '<script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>'
    + '<style>body{background:#172332;color:#d5e5ef;font:16px system-ui}canvas{width:768px;height:384px;image-rendering:pixelated}</style>'
    + '<p>Synthetic moving thin cloud: previous filter (left), depth-supported clamp (right)</p><canvas id="test"></canvas>' }));
  await page.route('**/src/volume-filter-reference.js', route => route.fulfill({ contentType: 'text/javascript', body: reference }));
  await page.goto(`http://127.0.0.1:${port}/tools/volume-filter.html`);
  const result = await page.evaluate(async () => {
    const T = await import('three');
    const { VolumetricPass: Current } = await import('/src/volumetric-pass-webgl.js');
    const { VolumetricPass: Original } = await import('/src/volume-filter-reference.js');
    const { FullScreenQuad } = await import('/vendor/jsm/postprocessing/Pass.js');
    const renderer = new T.WebGLRenderer({ canvas: document.querySelector('#test') });
    renderer.setSize(128, 64, false);renderer.debug.checkShaderErrors = true;
    const gl = renderer.getContext(), size = 64, center = 32;
    const camera = new T.PerspectiveCamera(60, 1, .1, 1e6);camera.updateMatrixWorld(true);
    const passes = { original: new Original(new T.Scene(), camera), current: new Current(new T.Scene(), camera) };
    const makeTarget = (width = size, height = size) => new T.WebGLRenderTarget(width, height, {
      type: T.HalfFloatType, minFilter: T.LinearFilter, magFilter: T.LinearFilter,
      depthTexture: new T.DepthTexture(width, height, T.UnsignedIntType),
    });
    const current = makeTarget(), history = makeTarget(), write = makeTarget(), fullDepth = makeTarget(size * 2, size * 2);
    const paintMaterial = new T.ShaderMaterial({ depthTest: true, depthFunc: T.AlwaysDepth, depthWrite: true,
      uniforms: { color: { value: null }, depth: { value: null } },
      vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0,1);}',
      fragmentShader: 'varying vec2 vUv;uniform sampler2D color,depth;void main(){gl_FragColor=texture2D(color,vUv);gl_FragDepth=texture2D(depth,vUv).r;}' });
    const paintQuad = new FullScreenQuad(paintMaterial);
    const dataTexture = (width, height, get) => {
      const data = new Float32Array(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(get(x, y), (y * width + x) * 4);
      const texture = new T.DataTexture(data, width, height, T.RGBAFormat, T.FloatType);texture.needsUpdate = true;
      return texture;
    };
    const paint = (target, color, depth = () => 1) => {
      const colorTexture = dataTexture(target.width, target.height, color);
      const depthTexture = dataTexture(target.width, target.height, (x, y) => [depth(x, y), 0, 0, 1]);
      paintMaterial.uniforms.color.value = colorTexture;paintMaterial.uniforms.depth.value = depthTexture;
      renderer.setRenderTarget(target);renderer.clear(true, true, false);paintQuad.render(renderer);
      colorTexture.dispose();depthTexture.dispose();
    };
    const read = target => {
      const raw = new Uint16Array(target.width * target.height * 4);renderer.setRenderTarget(target);
      renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, raw);
      return { raw, values: Float32Array.from(raw, value => T.DataUtils.fromHalfFloat(value)) };
    };
    const setup = (pass, source, previous, opaque, { offset = [0, 0], ready = true, valid = true } = {}) => {
      const u = pass.resolveMaterial.uniforms;
      u.tCurrent.value = source.texture;u.tHistory.value = previous.texture;
      u.tSceneDepth.value = opaque?.depthTexture || null;u.tHistoryDepth.value = previous.depthTexture;
      u.uHistoryValid.value = valid ? 1 : 0;if (u.uDepthReady) u.uDepthReady.value = ready ? 1 : 0;
      if (u.uStationaryHistory) u.uStationaryHistory.value = offset.every(value => value === 0) ? 1 : 0;
      u.uMotion.value = 0;u.uRadius.value = 10;u.uCenter.value.set(0, 0, 0);u.uNavDelta.value.set(0, 0, 0);
      u.uCurrentToPrevious.value.identity();u.uCameraFar.value = camera.far;
      u.uInvProjection.value.copy(camera.projectionMatrixInverse);u.uCameraWorld.value.copy(camera.matrixWorld);
      u.uPrevViewProjection.value.makeTranslation(2 * offset[0] / source.width, 2 * offset[1] / source.height, 0)
        .multiply(camera.projectionMatrix);
    };
    const draw = (pass, target = write) => { renderer.setRenderTarget(target);pass.resolveQuad.render(renderer);return read(target); };
    const sample = (pixels, x = center, y = center) => Array.from(pixels.values.slice((y * size + x) * 4, (y * size + x) * 4 + 4));
    const cases = [];
    const run = (name, options = {}, opaque = current) => {
      const row = { name };
      for (const [key, pass] of Object.entries(passes)) { setup(pass, current, history, opaque, options);row[key] = sample(draw(pass)); }
      cases.push(row);return row;
    };
    // Current legal neighbor includes red=1, so range clipping cannot conceal
    // a missing per-tap depth rejection. Only the nearest history tap is sky.
    paint(current, (x, y) => [x === center - 1 && y === center ? 1 : 0, 0, 0, .5]);
    paint(history, (x, y) => [x === center && y === center ? 0 : 1, 0, 0, .5],
      (x, y) => x === center && y === center ? 1 : .5);
    run('mixed-history-depth-taps', { offset: [.25, .25] });
    // A rejected color must not participate even through multiplication by
    // zero (0 * Inf/NaN is not zero). This is rejection, not HDR sanitization.
    paint(history, (x, y) => [x === center && y === center ? 0 : Infinity, 0, 0, .5],
      (x, y) => x === center && y === center ? 1 : .5);
    const rejectedNonfiniteStored = !Number.isFinite(sample(read(history), center + 1, center)[0]);
    run('rejected-nonfinite-taps', { offset: [.25, .25] }).nonfiniteActuallyStored = rejectedNonfiniteStored;
    paint(current, (x, y) => [x === center - 1 && y === center ? 1 : .125, 0, 0, .5]);
    paint(history, (x, y) => [x === center && y === center ? 1 : 0, 0, 0, .5],
      (x, y) => x === center && y === center ? 1 : .5);
    run('normalize-and-weight-partial-support', { offset: [.25, .25] });
    paint(current, (x, y) => [x === center - 1 && y === center ? 1 : 0, 0, 0, .5]);
    paint(history, () => [1, 0, 0, .5], () => .999998);run('opaque-is-not-sky');
    paint(history, () => [1, 0, 0, .5], () => 0);run('missing-depth', { ready: false }, null);
    paint(history, () => [1, 0, 0, .5], () => .5);run('all-history-taps-rejected');
    // A full-resolution depth texture deliberately disagrees between low-res
    // texel centers. Wrong-depth bright neighbors must not widen the HDR box.
    const base = [-.5, .3, .5, .4];
    paint(current, (x, y) => x === center && y === center - 1 ? [10, -10, 10, .99]
      : x === center - 1 && y === center ? [-.6, .2, .4, .3]
        : x === center + 1 && y === center ? [-.4, .4, .6, .5] : base);
    paint(fullDepth, () => [0, 0, 0, 1], (x, y) => {
      const lowX = Math.floor(x / 2), lowY = Math.floor(y / 2);
      return lowX === center && lowY === center - 1 ? 1 : .5;
    });
    paint(history, () => [-5, 5, -2, .4], () => .5);run('signed-box-with-foreign-neighbor', {}, fullDepth);
    paint(current, () => [-.25, -.125, -.5, .5]);paint(history, () => [-.375, -.25, -.75, .5]);run('all-negative-correction');
    paint(current, () => [0, 0, 0, 0]);paint(history, () => [.1, .1, .1, .2]);run('fully-cleared-neighborhood');
    paint(current, (x, y) => x === center - 1 && y === center ? [.75, 0, 0, .25] : [.125, 0, 0, .125]);
    paint(history, () => [.5, 0, 0, .875]);run('opacity-reject-before-range-clip');
    paint(current, () => [.25, .5, .75, .5]);paint(history, () => [.25, .5, .75, .5]);
    const constant = [];
    for (const offset of [[-.25, -.25], [.25, .25], [0, 0]]) {
      setup(passes.current, current, history, current, { offset });
      const actual = draw(passes.current);constant.push({ offset, changed: actual.values.filter((v, i) => v !== [.25, .5, .75, .5][i % 4]).length });
    }
    const firstFrame = [];
    paint(current, (x, y) => [x / size - .5, y / size, .25, .5]);paint(history, () => [20, 10, 5, .5]);
    const expectedFirst = read(current);
    for (const [name, pass] of Object.entries(passes)) {
      setup(pass, current, history, current, { valid: false });
      const pixels = draw(pass);firstFrame.push({ name, changed: pixels.raw.filter((v, i) => v !== expectedFirst.raw[i]).length });
    }

    // A periodic, zero-mean spatial noise field with known underlying signal.
    // No production sampler or weather source is replaced in the runtime.
    const signal = (x, y) => [-.15 + x / size * .3, .2 + y / size * .2, .3, .6];
    const noiseColor = (frame, x, y) => {
      let hash = Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663);hash ^= hash >>> 13;
      const phase = (hash >>> 0) % 16;
      const n = .06 * Math.sin(2 * Math.PI * (frame + phase) / 16);
      const value = signal(x, y);return [value[0] + n, value[1] - n, value[2] + n, value[3]];
    };
    const temporal = [];
    const moving = [];
    const finalImages = [];
    for (const [name, pass] of Object.entries(passes)) {
      let previous = makeTarget(), output = makeTarget();paint(previous, () => [0, 0, 0, 0]);paint(output, () => [0, 0, 0, 0]);
      let filteredSquared = 0, rawSquared = 0, meanError = 0, count = 0;
      for (let frame = 0; frame < 64; frame++) {
        paint(current, (x, y) => noiseColor(frame, x, y));setup(pass, current, previous, current, { valid: frame > 0 });
        const filtered = draw(pass, output), raw = read(current);
        if (frame >= 16) for (let y = 2; y < size - 2; y++) for (let x = 2; x < size - 2; x++) {
          const expected = signal(x, y), index = (y * size + x) * 4;
          for (let channel = 0; channel < 3; channel++) {
            const error = filtered.values[index + channel] - expected[channel];
            filteredSquared += error * error;meanError += error;
            rawSquared += (raw.values[index + channel] - expected[channel]) ** 2;count++;
          }
        }
        [previous, output] = [output, previous];
      }
      temporal.push({ name, count, rawMse: rawSquared / count, filteredMse: filteredSquared / count, meanError: meanError / count });
      let maximumTrail = 0, trailSquared = 0, trailCount = 0;
      paint(previous, () => [0, 0, 0, 0]);
      for (let frame = 0; frame < 32; frame++) {
        const left = 4 + frame;
        paint(current, (x, y) => x >= left && x < left + 12 && y >= 20 && y < 44 ? [.07, .05, .03, .18] : [0, 0, 0, 0]);
        setup(pass, current, previous, current, { valid: frame > 0 });
        const pixels = draw(pass, output);
        if (frame > 2) for (let y = 20; y < 44; y++) for (let x = 0; x < left - 1; x++) {
          const alpha = pixels.values[(y * size + x) * 4 + 3];maximumTrail = Math.max(maximumTrail, alpha);trailSquared += alpha * alpha;trailCount++;
        }
        [previous, output] = [output, previous];
      }
      moving.push({ name, maximumTrail, trailMse: trailSquared / trailCount, trailCount });
      finalImages.push(read(previous).values);previous.dispose();output.dispose();
    }
    // Display both final moving fixtures, with alpha as the visible coverage.
    const display = dataTexture(size * 2, size, (x, y) => {
      const values = finalImages[x < size ? 0 : 1], i = (y * size + x % size) * 4;
      return [.04 + values[i + 3] * 3, .08 + values[i + 1] * 3, .12 + values[i + 2] * 3, 1];
    });
    const show = new T.ShaderMaterial({ uniforms: { image: { value: display } }, depthTest: false, depthWrite: false,
      vertexShader: 'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0,1);}',
      fragmentShader: 'varying vec2 vUv;uniform sampler2D image;void main(){gl_FragColor=texture2D(image,vUv);}' });
    const showQuad = new FullScreenQuad(show);renderer.setRenderTarget(null);showQuad.render(renderer);
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const result = { cases, constant, firstFrame, temporal, moving, gl: gl.getError(), lost: gl.isContextLost(),
      gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
      scope: 'Actual resolve shader with real half-float/depth attachments, prescribed signed cloud correction and deterministic noise/motion controls. No production weather, full TAA, physical cloud motion, or player-art acceptance.' };
    for (const pass of Object.values(passes)) pass.dispose();for (const target of [current, history, write, fullDepth]) target.dispose();
    paintQuad.dispose();paintMaterial.dispose();showQuad.dispose();show.dispose();display.dispose();
    return result;
  });
  await page.screenshot({ path: `${out}/controls.png` });
  const after = await evidenceFingerprint('tools/volumehistoryfiltertest.js');
  await writeFile(`${out}/report.json`, JSON.stringify({ before, after, result, errors, warnings }, null, 2));
  assert.deepEqual(before, after);assert.deepEqual(errors, []);assert.equal(result.gl, 0);assert.equal(result.lost, false);
  const row = name => result.cases.find(value => value.name === name);
  for (const name of ['mixed-history-depth-taps', 'opaque-is-not-sky', 'missing-depth']) {
    assert.equal(row(name).current[0], 0, name);assert.ok(row(name).original[0] > .1, `${name} old negative control`);
  }
  assert.equal(row('all-history-taps-rejected').current[0], 0);
  assert.deepEqual(row('rejected-nonfinite-taps').current, [0, 0, 0, .5]);
  assert.equal(row('rejected-nonfinite-taps').nonfiniteActuallyStored, true);
  const partialSupportExpected = .125 + .875 * .5625 * .86 * Math.exp(-Math.hypot(.25, .25) / 64 * 48);
  assert.ok(Math.abs(row('normalize-and-weight-partial-support').current[0] - partialSupportExpected) < .0005);
  const signed = row('signed-box-with-foreign-neighbor');
  assert.ok(signed.current[0] < -.49 && signed.current[0] >= -.601);
  assert.ok(signed.current[1] >= .2 && signed.current[1] <= .401 && signed.current[2] >= .399 && signed.current[2] <= .601);
  assert.ok(signed.original[0] < -1 && signed.original[1] > 1);
  assert.deepEqual(row('all-negative-correction').current, [-.25, -.125, -.5, .5]);
  assert.deepEqual(row('fully-cleared-neighborhood').current, [0, 0, 0, 0]);
  assert.ok(row('fully-cleared-neighborhood').original[3] > .01);
  assert.deepEqual(row('opacity-reject-before-range-clip').current, [.125, 0, 0, .125]);
  assert.ok(result.constant.every(value => value.changed === 0));assert.ok(result.firstFrame.every(value => value.changed === 0));
  const oldNoise = result.temporal.find(value => value.name === 'original'), noise = result.temporal.find(value => value.name === 'current');
  assert.ok(noise.filteredMse < noise.rawMse * .5);assert.ok(noise.filteredMse <= oldNoise.filteredMse * 1.05 + 1e-6);
  assert.ok(Math.abs(noise.meanError) < .001);
  assert.equal(result.moving.find(value => value.name === 'current').maximumTrail, 0);
  assert.ok(result.moving.find(value => value.name === 'original').maximumTrail > .01);
  console.log(JSON.stringify({ out, temporal: result.temporal, moving: result.moving, passed: true }));
} catch (error) {
  await writeFile(`${out}/failure.json`, JSON.stringify({ before, errors, warnings, error: String(error), stack: error.stack }, null, 2));throw error;
} finally {
  await browser?.close();await new Promise(resolve => server.close(resolve));
}
