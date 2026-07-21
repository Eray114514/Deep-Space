import { startServer } from './server.js';
import { launchBrowser } from './browser.js';

const renderer = process.argv[2] || 'auto';
const { server, port } = await startServer(0);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('console', (message) => console.log(`[console:${message.type()}] ${message.text()}`));
page.on('pageerror', (error) => console.log(`[pageerror] ${error.stack || error}`));
try {
  await page.goto(`http://127.0.0.1:${port}/?nolock=1&post=0&farflora=0&renderer=${renderer}`,
    { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(12000);
  await page.screenshot({ path: `test-results/bootdiag-${renderer}.png` });
  console.log(await page.evaluate(() => ({
    booted: Boolean(window.NMS?.booted),
    error: document.querySelector('#err')?.textContent || '',
    loading: document.querySelector('#loading')?.className || '',
    stats: window.NMS?.stats?.() || null,
  })));
} finally {
  await browser.close();
  server.close();
}
