// B0 evidence acquisition. Records known visual defects; never grades them as
// acceptable art. Use B0_PROBE=1 for a one-world/day harness check (not closure).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const probe = process.env.B0_PROBE === '1';
const fingerprint = await evidenceFingerprint('tools/b0baselinetest.js');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const helperDigest = hash(await readFile('tools/b0-browser.js'));
const output = `test-results/b0-baseline/${fingerprint.sourceDigest.slice(0, 12)}${probe ? '-probe' : ''}`;
await mkdir(output, { recursive: true });
const scenes = ['S1-ground', 'S2-below', 'S2-inside', 'S2-above', 'S2-side', 'S3-oblique', 'S4-globe'];
const lights = probe ? [['day', 35]] : [['day', 35], ['twilight', -1], ['night', -30]];
const indices = probe ? [0] : [0, 2, 4];
const { server, port } = await startServer(0);
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const url = `http://127.0.0.1:${port}/?renderer=webgl&quality=ultra&freeze=1&time=9.5&nohero=1&vclouds=1&post=1&nolock=1`;
  await page.goto(url);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 150000 });
  await page.evaluate(async () => {
    window.B0 = await import('/tools/b0-browser.js');
    B0.installCaptureHold(); NMS.setAdaptiveQualityLocked(true);
  });
  const records = [], columns = [], traversals = [];
  const manifest = { phase: 'B0', scope: 'Reproducible baseline, not final visual/performance acceptance',
    probe, url, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    fingerprint, helperDigest, browser: browser.version(),
    gpu: await page.evaluate(() => {
      const gl = NMS._renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    }), records, columns, traversals, errors };
  async function checkpoint() { await writeFile(`${output}/manifest.json`, JSON.stringify(manifest, null, 2)); }
  async function waitFrames(count) {
    await page.evaluate((count) => new Promise((resolve) => {
      const tick = () => { if (--count <= 0) resolve(); else requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }), count);
  }
  async function image(name) {
    const bytes = await page.screenshot({ path: `${output}/${name}.png` });
    return { path: `${name}.png`, sha256: hash(bytes), bytes: bytes.length };
  }
  for (const index of indices) {
    for (const [light, degrees] of lights) {
      const lightState = await page.evaluate(({ index, degrees }) => {
        window.__b0Exposure = null;
        NMS.setAtmosphereVisible(true); NMS.setCloudsVisible(true, index);
        return B0.groundPose(index, degrees);
      }, { index, degrees });
      assert.ok(Math.abs(lightState.actualDegrees - degrees) < 3,
        `p${index} requested ${degrees}°, reached ${lightState.actualDegrees}°`);
      await page.waitForTimeout(1500);
      const column = await page.evaluate(({ index, degrees }) => B0.occupiedColumn(index, degrees), { index, degrees });
      columns.push({ index, light, lightState, ...column });
      for (const scene of scenes) {
        if (scene !== 'S1-ground') await page.evaluate(({ index, column, scene }) => {
          window.__b0Exposure = null; B0.cloudPose(index, column, scene);
        }, { index, column, scene });
        await page.waitForTimeout(800);
        await page.evaluate(() => { window.__b0Exposure = NMS._renderer.toneMappingExposure; });
        const captures = [];
        for (const variant of ['normal', 'air-off', 'clouds-off']) {
          await page.evaluate(({ index, variant }) => {
            NMS.setAtmosphereVisible(variant !== 'air-off');
            NMS.setCloudsVisible(variant !== 'clouds-off', index);
            NMS._pipeline.volumePass.resetHistory();
          }, { index, variant });
          await waitFrames(32);
          const state = await page.evaluate((i) => B0.snapshot(i), index);
          assert.equal(state.stats.rendererBackend, 'webgl2');
          assert.equal(state.atmosphere.activeBodyId, state.body.id, 'capture must use intended atmosphere');
          assert.equal(state.volume.activeBodyId, state.body.id, 'capture must use intended cloud field');
          assert.equal(state.atmosphere.depthReady, true);
          assert.equal(state.volume.cloudDepthReady, 1);
          const name = `p${index}-${light}-${scene}-${variant}`;
          captures.push({ variant, state, image: await image(name) });
        }
        const reference = captures[0].state;
        for (const capture of captures.slice(1)) {
          assert.equal(capture.state.weatherHours, reference.weatherHours);
          assert.equal(capture.state.render.exposure, reference.render.exposure);
          assert.equal(capture.state.weatherFingerprint, reference.weatherFingerprint);
          const delta = Math.hypot(...capture.state.camera.navLocalMeters.map((v, i) => v - reference.camera.navLocalMeters[i]));
          assert.ok(delta < 2, `paired camera drifted ${delta}m`);
        }
        records.push({ index, light, scene, captures });
        await page.evaluate((i) => { NMS.setAtmosphereVisible(true); NMS.setCloudsVisible(true, i); }, index);
        await checkpoint();
        console.log(`B0 captured p${index} ${light} ${scene}`);
      }
    }
  }
  assert.equal(new Set(records.map((r) => r.captures[0].state.body.seed)).size, indices.length);
  // A prescribed continuous trajectory, not a normal-flight speed acceptance.
  // rAF updates pose continuously; screenshots sample that trajectory with HUD.
  if (!probe) {
    const setup = columns.find((c) => c.index === 0 && c.light === 'day');
    await page.evaluate((setup) => {
      window.__b0Exposure = null; NMS.setTime(setup.lightState.hours);
      B0.cloudPose(0, setup, 'S2-below');
    }, setup);
    await page.waitForTimeout(1000);
    await page.evaluate(() => { window.__b0Exposure = NMS._renderer.toneMappingExposure; });
    for (const direction of ['up', 'down']) {
      await page.evaluate(({ setup, direction }) => {
        const duration = 12000, start = performance.now();
        const lo = setup.belowAltitude, hi = setup.aboveAltitude;
        window.__b0Motion = { done: false, telemetry: [] };
        const step = () => {
          const elapsed = performance.now() - start;
          const fraction = Math.min(1, elapsed / duration);
          const u = direction === 'up' ? fraction : 1 - fraction;
          const altitude = lo + (hi - lo) * u;
          NMS.setContinuousAtmosphereAltitude(0, altitude, { dir: setup.direction, pitch: 0 });
          __b0Motion.telemetry.push({ elapsed, altitude, frame: NMS.frame() });
          if (fraction < 1) requestAnimationFrame(step); else __b0Motion.done = true;
        };
        requestAnimationFrame(step);
      }, { setup, direction });
      const frames = [];
      while (!await page.evaluate(() => __b0Motion.done)) {
        const state = await page.evaluate(() => B0.snapshot(0));
        frames.push({ state, image: await image(`motion-${direction}-${String(frames.length).padStart(3, '0')}`) });
        await page.waitForTimeout(250);
      }
      const telemetry = await page.evaluate(() => __b0Motion.telemetry);
      assert.ok(frames.length >= 12 && telemetry.length > 100, 'continuous recording is too sparse');
      assert.ok(Math.min(...telemetry.map((t) => t.altitude)) < setup.insideAltitude
        && Math.max(...telemetry.map((t) => t.altitude)) > setup.insideAltitude, 'trajectory must cross occupied height');
      traversals.push({ direction, seconds: 12, scripted: true, frames, telemetry });
      await checkpoint();
    }
  }
  assert.deepEqual(errors, []);
  assert.equal(records.length, indices.length * lights.length * scenes.length);
  manifest.completed = true;
  await checkpoint();
  // Compact overview of every normal-chain image; originals remain alongside.
  const tiles = records.map((r) => `<figure><img src="${r.captures[0].image.path}"><figcaption>p${r.index} ${r.light} ${r.scene}</figcaption></figure>`).join('');
  await writeFile(`${output}/gallery.html`, `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:12px;background:#111;color:#eee;font:12px sans-serif}main{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}
    figure{margin:0}img{width:100%;display:block}figcaption{padding:4px}h1{font-size:18px}</style></head>
    <body><h1>B0 baseline — known defects preserved, not visual acceptance</h1><main>${tiles}</main></body></html>`);
  const gallery = await browser.newPage({ viewport: { width: 1680, height: 900 } });
  await gallery.goto(`http://127.0.0.1:${port}/${output}/gallery.html`);
  await gallery.locator('img').evaluateAll((images) => Promise.all(images.map((i) => i.decode())));
  await gallery.screenshot({ path: `${output}/matrix.png`, fullPage: true });
  console.log(`B0 baseline complete: ${records.length} poses, ${records.length * 3} images, ${traversals.length} continuous paths. ${output}`);
} finally {
  await browser?.close(); await new Promise((resolve) => server.close(resolve));
}
