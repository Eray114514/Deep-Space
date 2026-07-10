// Far-flora rendering diagnostics: does the mesh actually draw, where does
// an instance land on screen, did the patched shader compile?
import { startServer } from './server.js';
import { chromium } from 'playwright';

const { server, port } = await startServer(0);
const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on('console', (m) => {
  if (m.type() === 'error') console.error('CONSOLE:', m.text().replace(/[^\x20-\x7e\n]/g, '?').slice(0, 600));
});
await page.goto(`http://127.0.0.1:${port}/?seed=EUCLID&nolock=1&buildms=120`);
await page.waitForFunction('window.NMS && window.NMS.booted', null, { timeout: 90000 });
await page.evaluate('NMS.teleport(0, 0.006, {horizon: true})');
try { await page.waitForFunction('window.NMS.idle()', null, { timeout: 240000 }); } catch {}
await page.waitForTimeout(500);

const diag = await page.evaluate(() => {
  const ff = NMS._ff;
  if (!ff.meshes) return { error: 'no meshes' };
  const m0 = ff.meshes[0];
  const out = {
    counts: [ff.meshes[0].count, ff.meshes[1].count],
    visible: [ff.meshes[0].visible, ff.meshes[1].visible],
    parentChain: [],
    uCamL: ff.uCamL.value.toArray().map((v) => Math.round(v)),
    uAltK: ff.uAltK.value,
  };
  let o = m0;
  while (o) { out.parentChain.push(`${o.name || o.type}(v=${o.visible})`); o = o.parent; }
  // decompose a few instances: planet-local position and distance to camera
  const e = m0.instanceMatrix.array;
  out.samples = [];
  for (const i of [0, 1, Math.floor(m0.count / 2)]) {
    const px = e[i * 16 + 12], py = e[i * 16 + 13], pz = e[i * 16 + 14];
    const d = Math.hypot(px - ff.uCamL.value.x, py - ff.uCamL.value.y, pz - ff.uCamL.value.z);
    const sx = Math.hypot(e[i * 16 + 0], e[i * 16 + 1], e[i * 16 + 2]);
    out.samples.push({ i, dCam: Math.round(d), scale: sx.toFixed(2), r: Math.round(Math.hypot(px, py, pz)) });
  }
  // does hiding the meshes change drawn triangle count?
  const info = NMS._renderer.info.render;
  out.trisBefore = info.triangles;
  ff.meshes[0].visible = ff.meshes[1].visible = false;
  return out;
});
await page.waitForTimeout(400);
const trisHidden = await page.evaluate('NMS._renderer.info.render.triangles');
await page.evaluate('NMS._ff.meshes[0].visible = NMS._ff.meshes[1].visible = true');
await page.waitForTimeout(400);
const trisShown = await page.evaluate('NMS._renderer.info.render.triangles');
const progs = await page.evaluate(() =>
  NMS._renderer.info.programs.map((p) => ({ n: p.name, diag: p.diagnostics ? String(p.diagnostics.fragmentShader?.log || p.diagnostics.vertexShader?.log || p.diagnostics.programLog).slice(0, 300) : null }))
    .filter((p) => p.diag));

console.log(JSON.stringify(diag, null, 1));
console.log('tris hidden vs shown:', trisHidden, trisShown, 'delta', trisShown - trisHidden);
console.log('failed programs:', JSON.stringify(progs));
await browser.close();
server.close();
process.exit(0);
