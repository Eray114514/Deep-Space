// One-off diagnosis: zoom on the lava planet and toggle layers to find
// what is painting the whole disc orange.

import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { chromium } from 'playwright';

await mkdir('screenshots/diag', { recursive: true });
const { server, port } = await startServer(0);
const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('PAGEERROR:', String(e).split('\n')[0]));

await page.goto(`http://127.0.0.1:${port}/?seed=EUCLID&nolock=1`);
await page.waitForFunction('window.NMS && window.NMS.booted', null, { timeout: 60000 });

const planets = await page.evaluate('window.NMS.planets()');
const lavaI = planets.find((p) => p.type === 'lava').i;
await page.evaluate(`NMS.teleport(${lavaI}, 1.5)`);
await page.waitForFunction('window.NMS.idle()', null, { timeout: 90000 });

const clip = { x: 440, y: 160, width: 400, height: 400 };
await page.screenshot({ path: 'screenshots/diag/lava-all.png', clip });

const report = await page.evaluate(`(() => {
  const u = NMS._internals.universe;
  const p = u.system.planets[${lavaI}];
  return {
    R: p.R, seaLevel: p.seaLevel, seaRadius: p.seaRadius, hAmp: p.hAmp,
    contAmp: p.contAmp, liquid: p.liquid,
    liquidGeoRadius: p.liquidMesh ? p.liquidMesh.geometry.parameters.radius : null,
    atmo: !!p.atmoMesh, clouds: !!p.cloudMesh,
    chunkSample: (() => {
      const root = p.lod.roots[0];
      const pos = root.mesh.geometry.attributes.position;
      let min = 1e9, max = -1e9;
      for (let i = 0; i < pos.count; i++) {
        const r = Math.hypot(pos.getX(i), pos.getY(i), pos.getZ(i));
        min = Math.min(min, r); max = Math.max(max, r);
      }
      return { minR: min, maxR: max };
    })(),
  };
})()`);
console.log('lava planet:', JSON.stringify(report, null, 1));

await page.evaluate(`NMS._internals.universe.system.planets[${lavaI}].liquidMesh.visible = false`);
await page.waitForTimeout(400);
await page.screenshot({ path: 'screenshots/diag/lava-no-liquid.png', clip });

await page.evaluate(`(() => {
  const p = NMS._internals.universe.system.planets[${lavaI}];
  p.liquidMesh.visible = true;
  if (p.atmoMesh) p.atmoMesh.visible = false;
})()`);
await page.waitForTimeout(400);
await page.screenshot({ path: 'screenshots/diag/lava-no-atmo.png', clip });

await browser.close();
server.close();
console.log('done');
