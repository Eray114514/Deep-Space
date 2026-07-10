// Bisect the far-flora material: plain basic material, then the standard
// material unpatched, then with uniforms only, then the full fade patch —
// screenshot each and report which stage kills the program.
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
  await page.screenshot({ path: `screenshots/v20/_bisect-${name}.png` });
  const fails = await page.evaluate(
    'NMS._renderer.info.programs.filter(p => p.diagnostics).length');
  console.log(`${name}: failed programs = ${fails}`);
}

await stage('0-asis', ';');
await stage('1-basic', `
  for (const im of NMS._ff.meshes) {
    im.userData.orig = im.material;
    im.material = new NMS._THREE.MeshBasicMaterial({ color: 0xff2222 });
  }`);
await stage('2-std-unpatched', `
  for (const im of NMS._ff.meshes) {
    im.material = new NMS._THREE.MeshStandardMaterial({ color: 0xff2222, vertexColors: true, flatShading: true });
  }`);
await stage('3-std-patched', `
  for (const im of NMS._ff.meshes) {
    const mat = new NMS._THREE.MeshStandardMaterial({ color: 0xff2222, vertexColors: true, flatShading: true });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uCamL = NMS._ff.uCamL;
      shader.uniforms.uAltK = NMS._ff.uAltK;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\\nuniform vec3 uCamL;\\nuniform float uAltK;')
        .replace('#include <begin_vertex>', \`#include <begin_vertex>
          #ifdef USE_INSTANCING
          {
            float d = distance(instanceMatrix[3].xyz, uCamL);
            float g = smoothstep(150.0, 205.0, d) * (1.0 - smoothstep(3900.0, 4400.0, d)) * uAltK;
            g *= 1.15 + 1.15 * smoothstep(450.0, 2400.0, d);
            transformed *= g;
          }
          #endif\`);
    };
    mat.customProgramCacheKey = () => 'bisect3';
    im.material = mat;
  }`);

await browser.close();
server.close();
process.exit(0);
