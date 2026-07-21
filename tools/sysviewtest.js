import { startServer } from './server.js';
import { launchBrowser, launchWebGPUHardwareBrowser } from './browser.js';

const { server, port } = await startServer(0);
const browser = await launchBrowser();
let failures = 0;

try {
  for (const scene of ['planetary', 'black-hole']) {
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      const text = message.text();
      if (message.type() === 'error' || /NodeBuilder|WebGLProgram|shader error|INVALID_OPERATION/i.test(text)) errors.push(text);
    });
    await page.goto(`http://127.0.0.1:${port}/tools/sysview-fixture.html?renderer=webgl&scene=${scene}`);
    await page.waitForFunction(() => window.SYSVIEW_RESULT?.ready, null, { timeout: 90000 });
    const result = await page.evaluate(() => window.SYSVIEW_RESULT);
    const ok = result.backend === 'webgl2' && result.nodeMaterials > 0 && errors.length === 0;
    console.log(`${ok ? 'PASS' : 'FAIL'}: sysview ${scene} ${result.backend}, ${result.nodeMaterials} node materials`);
    if (errors.length) console.log(errors.join('\n'));
    if (!ok) failures++;
    await page.close();
  }
  const webgpuBrowser = await launchWebGPUHardwareBrowser({ headless: true });
  if (webgpuBrowser) {
    const page = await webgpuBrowser.newPage({ viewport: { width: 960, height: 540 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    page.on('console', (message) => {
      const text = message.text();
      if (message.type() === 'error' || /NodeBuilder|shader error|validation/i.test(text)) errors.push(text);
    });
    try {
      await page.goto(`http://127.0.0.1:${port}/tools/sysview-fixture.html?renderer=webgpu&scene=black-hole`);
      await page.waitForFunction(() => window.SYSVIEW_RESULT?.ready, null, { timeout: 90000 });
      const result = await page.evaluate(() => window.SYSVIEW_RESULT);
      const ok = result.backend === 'webgpu' && result.nodeMaterials > 0 && errors.length === 0;
      console.log(`${ok ? 'PASS' : 'FAIL'}: sysview black-hole ${result.backend}, ${result.nodeMaterials} node materials`);
      if (errors.length) console.log(errors.join('\n'));
      if (!ok) failures++;
    } finally {
      await webgpuBrowser.close();
    }
  } else {
    console.log('SKIP: no installed Chrome/Edge for real WebGPU sysview validation');
  }
} finally {
  await browser.close();
  server.close();
}

process.exit(failures ? 1 : 0);
