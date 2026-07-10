// Dump the failing program's vertex shader: the defines block and the
// lines around the reported error (0:83 'isPerspectiveMatrix').
import { startServer } from './server.js';
import { chromium } from 'playwright';

const { server, port } = await startServer(0);
const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
await page.goto(`http://127.0.0.1:${port}/?seed=EUCLID&nolock=1&buildms=120`);
await page.waitForFunction('window.NMS && window.NMS.booted', null, { timeout: 90000 });
await page.evaluate('NMS.teleport(0, 0.006, {horizon: true})');
await page.waitForTimeout(12000);

const dump = await page.evaluate(() => {
  const gl = NMS._renderer.getContext();
  const bad = NMS._renderer.info.programs.filter((p) => p.diagnostics);
  return bad.map((p) => {
    let src = '';
    try { src = gl.getShaderSource(p.vertexShader) || ''; } catch (e) { src = 'ERR ' + e; }
    const lines = src.split('\n');
    return {
      cacheKey: String(p.cacheKey).slice(0, 400),
      usedTimes: p.usedTimes,
      defines: lines.filter((l) => l.startsWith('#define')).slice(0, 40).join(' | '),
      around83: lines.slice(70, 96).map((l, i) => (i + 71) + ': ' + l).join('\n'),
    };
  });
});
console.log(JSON.stringify(dump, null, 1).slice(0, 4000));
await browser.close();
server.close();
process.exit(0);
