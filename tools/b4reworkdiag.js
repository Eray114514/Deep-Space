// Repeatable failure attribution; captures do not constitute visual acceptance.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';

const output = process.env.B4_OUTPUT || 'test-results/b4-rework/diagnosis';
await mkdir(output, { recursive: true });
const baseline = JSON.parse(await readFile('docs/baselines/b4-local-2026-09-27/manifest.json'));
const { server, port } = await startServer(0);
const browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined, headless: true });
const errors = [], records = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') { errors.push(m.text()); console.error(m.text()); } });
  await page.goto(`http://127.0.0.1:${port}/?quality=ultra&freeze=1&time=9.5&nohero=1&vclouds=1&post=1&nolock=1`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 150000 });
  console.log('Booted for cloud rework attribution.');
  await page.evaluate(async () => {
    window.B0 = await import('/tools/b0-browser.js');
    B0.installCaptureHold(); NMS.setAdaptiveQualityLocked(true);
  });
  const column = baseline.columns.find(c => c.index === 0 && c.light === 'day');
  for (const scene of (process.env.B4_SCENES || 'S4-globe,S3-oblique,S2-above,S2-side,S2-inside,S2-below').split(',')) {
    await page.evaluate(({ column, scene }) => B0.cloudPose(0, column, scene), { column, scene });
    await page.waitForTimeout(1200);
    await page.evaluate(() => { window.__b0Exposure = NMS._renderer.toneMappingExposure; });
    for (const variant of (process.env.B4_VARIANTS || 'normal,air-off,clouds-off').split(',')) {
      await page.evaluate(variant => {
        NMS.setAtmosphereVisible(variant !== 'air-off'); NMS.setCloudsVisible(variant !== 'clouds-off', 0);
        NMS._pipeline.volumePass.resetHistory();
      }, variant);
      const start = await page.evaluate(() => __b0RenderedFrames);
      await page.waitForFunction(start => __b0RenderedFrames > start + 32, start, { timeout: 150000 });
      const name = `${scene}-${variant}.png`;
      await page.screenshot({ path: `${output}/${name}` });
      records.push({ scene, variant, path: name, state: await page.evaluate(() => B0.snapshot(0)) });
      console.log(name);
    }
    await page.evaluate(() => { NMS.setAtmosphereVisible(true); NMS.setCloudsVisible(true, 0); window.__b0Exposure = null; });
  }
  await writeFile(`${output}/report.json`, JSON.stringify({ records, errors }, null, 2));
  if (errors.length) throw Error(errors.join('\n'));
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
