import { mkdir, readFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchBrowser } from './browser.js';

const report = JSON.parse(await readFile('worlds/finite-candidates.json', 'utf8'));
const candidates = report.top12;
const output = 'docs/curation/finite-galaxy';
await mkdir(output, { recursive: true });
const { server, port } = await startServer(0);
const browser = await launchBrowser();
try {
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/?nolock=1&post=0&farflora=0&quality=low&worldlab=1&seed=${candidate.seed}`);
    await page.waitForFunction('NMS?.booted', null, { timeout: 60000 });
    await page.evaluate(() => NMS.openStarMap());
    await page.waitForTimeout(700);
    await page.mouse.move(760, 420);
    for (let i = 0; i < 16; i++) await page.mouse.wheel(0, 900);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${output}/${String(index + 1).padStart(2, '0')}-${candidate.seed}.png` });
    await page.close();
    console.log(`CAPTURED ${index + 1}/12 ${candidate.seed}`);
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
