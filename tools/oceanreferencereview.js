import { mkdir } from 'node:fs/promises';
import { launchHardwareBrowser } from './browser.js';

const output = 'test-results/ocean-references';
await mkdir(output, { recursive: true });
const browser = await launchHardwareBrowser({ headless: true });
try {
  for (const [id, port] of [['pelagic', 5181], ['cinematic', 5182]]) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(12000);
    await page.screenshot({ path: `${output}/${id}-default.png` });
    console.log(JSON.stringify({ id, errors,
      buttons: await page.getByRole('button').allTextContents() }, null, 2));
    for (const [scene, label] of [['breeze', '微风海面'], ['storm', '风暴巨浪'],
      ['miller', '米勒星球'], ['alien', id === 'pelagic' ? '荧光星海' : '双日紫海']]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.waitForTimeout(scene === 'miller' ? 22000 : 6000);
      await page.screenshot({ path: `${output}/${id}-${scene}.png` });
      console.log(JSON.stringify({ id, scene, errors }));
    }
    await page.close();
  }
} finally {
  await browser.close();
}
