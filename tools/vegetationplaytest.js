import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchBrowser, launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const out = 'test-results/vegetation-player';
await mkdir(out, { recursive: true });
const fingerprint = await evidenceFingerprint('tools/vegetationplaytest.js');
const { server, port } = await startServer(0);
let browser;
const errors = [];
try {
  browser = process.env.VEGETATION_HARDWARE === '1'
    ? await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined }) : await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${port}/?nolock=1&nohero=1&scene=walk&planet=0&bias=meadow`
    + '&quality=balanced&freeze=1&time=9.5&farflora=1&vclouds=0&post=1&buildms=35');
  await page.waitForFunction(() => NMS?.booted, null, { timeout: 150000 });
  await page.evaluate(() => { NMS.setAdaptiveQualityLocked(true); NMS.setLocalSunAltitude(0,35); NMS.lookPitch(-20); });
  const settled = async () => page.waitForFunction(() => {
    const s = NMS.stats();
    return s.grassField.total > 20 && !s.grassField.pending && s.terrainPending === 0
      && s.waterPending === 0 && NMS._ff.pending() === 0;
  }, null, { timeout: 120000 });
  await settled();
  const initial = await page.evaluate(() => {
    const p = NMS.referenceState().playerLocal;
    const direction = p.map(value => value/Math.hypot(...p));
    window.__vegetationShadowDraws = { depth: 0, distance: 0 };
    NMS._internals.scene.traverse(mesh => {
      if (!mesh.name.startsWith('scatter:')) return;
      const previous = mesh.onBeforeShadow;
      mesh.onBeforeShadow = function (...args) {
        __vegetationShadowDraws[args[5].isMeshDistanceMaterial ? 'distance' : 'depth']++;
        previous.apply(this,args);
      };
    });
    return { direction, field: NMS.stats().grassField, frame: NMS.stats().frame };
  });
  await page.waitForFunction(frame => NMS.stats().frame > frame+5, initial.frame);
  await page.screenshot({ path: `${out}/meadow.png` });
  const poses = [];
  const capture = async label => {
    const state = await page.evaluate(() => ({ stats: NMS.stats(), gl: NMS._renderer.getContext().getError(),
      shadows: __vegetationShadowDraws }));
    poses.push({ label, ...state });
    assert.equal(state.gl,0,`${label}: whole-player GL gate`);
  };
  await capture('initial');
  const away = await page.evaluate(direction => {
    const T = NMS._THREE, up = new T.Vector3(...direction);
    const tangent = new T.Vector3().crossVectors(up, Math.abs(up.y)<.9 ? new T.Vector3(0,1,0) : new T.Vector3(1,0,0)).normalize();
    return up.addScaledVector(tangent,42/NMS.referenceState().terrainRadius).normalize().toArray();
  },initial.direction);
  assert.equal(await page.evaluate(direction => NMS.setWalkDirection(direction),away),true);
  await page.waitForFunction(signature => NMS.stats().grassField.signature !== signature,initial.field.signature,{ timeout: 90000 });
  await settled(); await capture('42m-away');
  await page.screenshot({ path: `${out}/away.png` });
  assert.equal(await page.evaluate(direction => NMS.setWalkDirection(direction),initial.direction),true);
  await settled();
  await page.waitForFunction(signature => NMS.stats().grassField.signature === signature,initial.field.signature,{ timeout: 90000 });
  await capture('return');
  await page.keyboard.down('KeyW'); await page.waitForTimeout(500); await page.keyboard.up('KeyW');
  await page.waitForTimeout(80);
  assert.ok(await page.evaluate(() => NMS.stats().surfaceInteractions > 0),'Normal walking must inject pressure.');
  await capture('walking-pressure');
  await page.screenshot({ path: `${out}/walking.png` });
  assert.ok(poses[0].shadows.depth > 0,'Native directional shadow draws must use the custom deformation.');
  const finalFingerprint = await evidenceFingerprint('tools/vegetationplaytest.js');
  await writeFile(`${out}/report.json`,JSON.stringify({ fingerprint,
    stableSource:fingerprint.sourceDigest===finalFingerprint.sourceDigest,initial,poses,errors,
    scope:'Real home world, 1280x720 Balanced, normal HUD/post, volume clouds disabled; not full-cloud visual/performance acceptance' },null,2));
  assert.deepEqual(errors,[]);
  console.log(`PASS: normal player near/far meadow, 42m rebase/return, walking pressure and native shadow draws; ${out}`);
} finally { await browser?.close(); await new Promise(resolve=>server.close(resolve)); }
