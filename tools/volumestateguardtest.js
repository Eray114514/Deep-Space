// Real WebGL state ownership and unchanged-success-output controls. The tiny
// fixture exercises the actual pass; it is not a cloud-art or FPS acceptance.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const out = `test-results/volume-state/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const before = await evidenceFingerprint('tools/volumestateguardtest.js');
const referenceCommit = '5855f28';
const reference = execFileSync('git', ['show', `${referenceCommit}:src/volumetric-pass-webgl.js`]);
const foregroundReference = execFileSync('git', ['show', `${referenceCommit}:src/foreground-pass.js`]);
await writeFile(`${out}/reference-volumetric-pass-webgl.js`, reference);
await writeFile(`${out}/reference-foreground-pass.js`, foregroundReference);
const { server, port } = await startServer(0);
let browser;
const errors = [];
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  const page = await browser.newPage({ viewport: { width: 640, height: 420 } });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/tools/volume-state-fixture.html', route => route.fulfill({ contentType: 'text/html', body:
    '<!doctype html><meta charset="utf-8"><title>Volume state ownership</title>'
    + '<script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>'
    + '<style>body{background:#172332;color:#d5e5ef;font:16px system-ui}canvas{width:320px;height:320px;image-rendering:pixelated}</style>'
    + '<p>Actual WebGL volume pass: exception recovery and native HDR controls</p><canvas id="test"></canvas>' }));
  await page.route('**/src/volume-state-reference.js', route => route.fulfill({ contentType: 'text/javascript', body: reference }));
  await page.route('**/src/foreground-state-reference.js', route => route.fulfill({ contentType: 'text/javascript', body: foregroundReference }));
  await page.goto(`http://127.0.0.1:${port}/tools/volume-state-fixture.html`);
  const result = await page.evaluate(async () => {
    const T = await import('/vendor/three.module.js');
    const { VolumetricPass: Current } = await import('/src/volumetric-pass-webgl.js');
    const { VolumetricPass: Original } = await import('/src/volume-state-reference.js');
    const { ForegroundPass: ForegroundCurrent } = await import('/src/foreground-pass.js');
    const { ForegroundPass: ForegroundOriginal } = await import('/src/foreground-state-reference.js');
    const renderer = new T.WebGLRenderer({ canvas: document.querySelector('#test'), antialias: false });
    renderer.setSize(32, 32, false);renderer.debug.checkShaderErrors = true;
    const gl = renderer.getContext();
    const target = () => new T.WebGLRenderTarget(32, 32, { type: T.HalfFloatType,
      depthTexture: new T.DepthTexture(32, 32, T.UnsignedIntType) });
    const read = target(), write = target(), cube = new T.WebGLCubeRenderTarget(16);
    const scene = new T.Scene(), camera = new T.PerspectiveCamera(60, 1, .1, 100);
    camera.position.z = 2;camera.updateMatrixWorld(true);
    const geometry = new T.PlaneGeometry(4, 4);
    const material = new T.ShaderMaterial({ depthTest: false, depthWrite: false, transparent: true,
      vertexShader: 'void main(){gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1);}',
      fragmentShader: 'void main(){gl_FragColor=vec4(.15,.3,.45,.5);}' });
    const mesh = new T.Mesh(geometry, material);mesh.layers.set(2);scene.add(mesh);
    const current = new Current(scene, camera), original = new Original(scene, camera);
    current.setSize(32, 32);original.setSize(32, 32);
    const record = () => ({ mask: camera.layers.mask, autoClear: renderer.autoClear,
      clear: renderer.getClearColor(new T.Color()).toArray(), alpha: renderer.getClearAlpha(),
      target: renderer.getRenderTarget() === cube, face: renderer.getActiveCubeFace(),
      mip: renderer.getActiveMipmapLevel(), nativeFace: gl.getFramebufferAttachmentParameter(
        gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE) });
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const seed = () => {
      camera.layers.mask = 129;renderer.autoClear = false;
      renderer.setClearColor(new T.Color(.12, .23, .34), .37);
      renderer.setRenderTarget(cube, 3, 0);
      return record();
    };
    renderer.setRenderTarget(read);renderer.setClearColor(new T.Color(.05, .1, .15), 1);renderer.clear(true, true, false);
    const faults = [];
    const inject = (pass, phase, callback) => {
      const object = phase === 'volume' ? mesh : phase === 'resolve' ? pass.resolveQuad._mesh : pass.compositeQuad._mesh;
      const old = object.onBeforeRender;object.onBeforeRender = callback;
      return () => { object.onBeforeRender = old; };
    };
    try {
      for (const [name, pass] of [['original', original], ['current', current]]) {
        for (const phase of ['volume', 'resolve', 'composite']) {
          const before = seed(), frame = pass.frame, error = new Error(`controlled ${phase} callback`);
          pass.historyValid = true;let invoked = 0, caught = false;
          const restore = inject(pass, phase, () => { invoked++;throw error; });
          try { pass.render(renderer, write, read); } catch (actual) { caught = actual === error; }
          finally { restore(); }
          const after = record();
          faults.push({ name, phase, before, after, restored: same(before, after),
            historyInvalid: pass.historyValid === false, frameUncommitted: pass.frame === frame, invoked, caught });
          // Fixture cleanup is explicit; it must not conceal the old failure.
          pass.resetHistory();seed();
        }
      }
      const captures = [], successfulStates = [];
      for (const [name, pass] of [['original', original], ['current', current], ['original', original], ['current', current]]) {
        const before = seed();pass.resetHistory();pass.render(renderer, write, read);
        const after = record();successfulStates.push({ name, before, after, restored: same(before, after) });
        const pixels = new Uint16Array(32 * 32 * 4);
        // Vendor readback restores a raw framebuffer field, which is an array
        // for cube targets. Bind the readback target explicitly after recording
        // ownership; this avoids making that separate helper bug our oracle.
        renderer.setRenderTarget(write);
        renderer.readRenderTargetPixels(write, 0, 0, 32, 32, pixels);captures.push(pixels);
      }
      const comparisons = captures.slice(1).map(pixels => {
        let changed = 0;for (let i = 0; i < pixels.length; i++) if (pixels[i] !== captures[0][i]) changed++;
        return changed;
      });
      const visibility = mesh.visible;
      let noVolumeChanged = 0;
      try {
        mesh.visible = false;seed();current.resetHistory();current.render(renderer, write, read);
        const empty = new Uint16Array(32 * 32 * 4);renderer.setRenderTarget(write);
        renderer.readRenderTargetPixels(write, 0, 0, 32, 32, empty);
        for (let i = 0; i < empty.length; i++) if (i % 4 !== 3 && empty[i] !== captures[0][i]) noVolumeChanged++;
      } finally { mesh.visible = visibility; }
      // A caught callback can invoke a separate pass before returning. Each
      // frame must retain its own clear color, even though scratch is shared.
      const nestedControls = [];
      for (const [name, pass, Type] of [['original', original, Original], ['current', current, Current]]) {
        const nested = new Type(new T.Scene(), camera);nested.setSize(32, 32);
        const nestedWrite = target();let invoked = 0;
        const before = seed();
        const restore = inject(pass, 'volume', () => {
          invoked++;renderer.setClearColor(new T.Color(.8, .7, .6), .4);
          nested.render(renderer, nestedWrite, read);
        });
        try { pass.resetHistory();pass.render(renderer, write, read); }
        finally { restore();nested.dispose();nestedWrite.dispose(); }
        const after = record();nestedControls.push({ name, before, after, restored: same(before, after),
          clearRestored: same(before.clear, after.clear), invoked });
      }
      const foreground = [];
      for (const [name, Type] of [['original', ForegroundOriginal], ['current', ForegroundCurrent]]) {
        const pass = new Type(scene, camera, [2, 3]);
        for (const fail of [false, true]) {
          const before = seed(), error = new Error('controlled foreground callback');
          const callback = mesh.onBeforeRender;let caught = false, invoked = 0;
          mesh.onBeforeRender = () => { invoked++;if (fail) throw error; };
          try { pass.render(renderer, write, read); } catch (actual) { caught = actual === error; }
          finally { mesh.onBeforeRender = callback; }
          const after = record();foreground.push({ name, fail, caught, invoked, before, after, restored: same(before, after) });
        }
      }
      // Present the successful output. This is a small controlled pass image.
      renderer.setRenderTarget(null);renderer.autoClear = true;
      const quadScene = new T.Scene(), quadCamera = new T.Camera();
      const present = new T.ShaderMaterial({ uniforms: { image: { value: write.texture } }, depthTest: false,
        vertexShader: 'void main(){gl_Position=vec4(position.xy,0,1);}',
        fragmentShader: 'uniform sampler2D image;void main(){gl_FragColor=texelFetch(image,ivec2(gl_FragCoord.xy),0);}' });
      quadScene.add(new T.Mesh(geometry, present));renderer.render(quadScene, quadCamera);present.dispose();
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return { faults, successfulStates, comparisons, noVolumeChanged, foreground, nestedControls,
        finite: captures.every(pixels => [...pixels].every(value => Number.isFinite(T.DataUtils.fromHalfFloat(value)))),
        nonempty: captures[0].some((value, i) => i % 4 !== 3 && value > 0), gl: gl.getError(), lost: gl.isContextLost(),
        gpu: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
        scope: 'Actual pass and native RGBA16F controls on a 32x32 cloud-layer fixture; no production weather/art, continuous gameplay or FPS acceptance.' };
    } finally {
      current.dispose();original.dispose();read.dispose();write.dispose();cube.dispose();geometry.dispose();material.dispose();
    }
  });
  await page.screenshot({ path: `${out}/fixture.png` });
  const after = await evidenceFingerprint('tools/volumestateguardtest.js');
  const report = { before, after, referenceCommit, referenceSha256: createHash('sha256').update(reference).digest('hex'),
    foregroundReferenceSha256: createHash('sha256').update(foregroundReference).digest('hex'), result, errors };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  assert.equal(before.sourceDigest, after.sourceDigest);assert.equal(before.verifierDigest, after.verifierDigest);
  assert.deepEqual(errors, []);assert.equal(result.gl, 0);assert.equal(result.lost, false);
  assert.ok(result.finite && result.nonempty);assert.deepEqual(result.comparisons, [0, 0, 0]);
  assert.ok(result.noVolumeChanged > 1000, 'Native equality must include a visible volume contribution');
  assert.ok(result.faults.filter(f => f.name === 'original').every(f => !f.restored && !f.historyInvalid && f.caught && f.invoked === 1));
  assert.ok(result.faults.filter(f => f.name === 'current').every(f => f.restored && f.historyInvalid && f.frameUncommitted && f.caught && f.invoked === 1));
  assert.ok(result.successfulStates.filter(f => f.name === 'original').every(f => !f.restored));
  assert.ok(result.successfulStates.filter(f => f.name === 'current').every(f => f.restored));
  assert.ok(result.nestedControls.every(f => f.invoked === 1));
  assert.ok(result.nestedControls.filter(f => f.name === 'original').every(f => !f.restored && !f.clearRestored));
  assert.ok(result.nestedControls.filter(f => f.name === 'current').every(f => f.restored && f.clearRestored));
  assert.ok(result.foreground.filter(f => f.name === 'original').every(f => !f.restored && f.caught === f.fail && f.invoked === 1));
  assert.ok(result.foreground.filter(f => f.name === 'current').every(f => f.restored && f.caught === f.fail && f.invoked === 1));
  console.log(`PASS real WebGL volume state and native-output controls: ${out}`);
} catch (error) {
  await writeFile(`${out}/failure.json`, JSON.stringify({ before, referenceCommit, errors, error: String(error) }, null, 2));
  throw error;
} finally {
  try { await browser?.close(); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
