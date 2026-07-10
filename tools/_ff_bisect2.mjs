// Why are far trees dark? A: real materials with huge emissive;
// B: red standard WITHOUT vertexColors; C: real materials, no shadows.
import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { chromium } from 'playwright';

await mkdir('screenshots/v20', { recursive: true });
const { server, port } = await startServer(0);
const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
await page.goto(`http://127.0.0.1:${port}/?seed=EUCLID&nolock=1&buildms=120`);
await page.waitForFunction('window.NMS && window.NMS.booted', null, { timeout: 90000 });
await page.evaluate('NMS.teleport(0, 0.006, {horizon: true})');
try { await page.waitForFunction('window.NMS.idle()', null, { timeout: 240000 }); } catch {}

async function stage(name, js) {
  await page.evaluate(js);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `screenshots/v20/_b2-${name}.png` });
  console.log(`✓ ${name}`);
}

await stage('A-emissive5', `
  for (const im of NMS._ff.meshes) {
    im.userData.orig = im.material;
    const m = im.material.clone();
    m.onBeforeCompile = im.material.onBeforeCompile;
    m.customProgramCacheKey = () => 'b2a';
    m.emissive.setScalar(5);
    im.material = m;
  }`);
await stage('B-red-novcolor', `
  for (const im of NMS._ff.meshes) {
    im.material = new NMS._THREE.MeshStandardMaterial({ color: 0xff2222, flatShading: true });
  }`);
await stage('C-noshadow', `
  for (const im of NMS._ff.meshes) {
    im.material = im.userData.orig;
    im.receiveShadow = false;
  }`);

await browser.close();
server.close();
process.exit(0);
