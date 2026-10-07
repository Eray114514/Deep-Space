// Attribution probe: drain errors after mutating GL calls until the first
// failure. This deliberately slow mode is never used for performance evidence.
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
const { server, port } = await startServer(0);
let browser;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath(), headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    window.__glFailures = [];
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) {
      const gl = getContext.apply(this, args);
      if (!gl || args[0] !== 'webgl2' || gl.__errorProbe) return gl;
      gl.__errorProbe = true;
      const getError = gl.getError.bind(gl);
      for (const name of Object.getOwnPropertyNames(WebGL2RenderingContext.prototype)
        .concat(Object.getOwnPropertyNames(WebGLRenderingContext.prototype))) {
        if (!/^(uniform|tex|framebuffer|renderbuffer|buffer|draw|copy|readPixels|viewport|scissor|bind)/.test(name)
          || typeof gl[name] !== 'function' || gl[name].__probed) continue;
        const original = gl[name].bind(gl);
        const wrapped = function (...values) {
          const result = original(...values);
          if (!__glFailures.length) {
            const error = getError();
            if (error) __glFailures.push({ name, error,
              values: values.map(v => ArrayBuffer.isView(v) ? { type: v.constructor.name, length: v.length }
                : typeof v === 'object' ? String(v) : v), stack: new Error().stack });
          }
          return result;
        };
        wrapped.__probed = true; gl[name] = wrapped;
      }
      return gl;
    };
  });
  await page.goto(`http://127.0.0.1:${port}/?quality=ultra&freeze=1&time=9.5&nohero=1&vclouds=1&post=1&nolock=1`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 180000 });
  await page.evaluate(async () => {
    window.B0=await import('/tools/b0-browser.js');
    B0.installCaptureHold();NMS.setAdaptiveQualityLocked(true);
    B0.occupiedColumn(0,55,{speciesId:'stratocumulus'});
  });
  await page.evaluate(() => NMS.setAtmosphereAltitude(0, 30000,
    { dir: [-.7817630820403421, .6181640625, .08197362619941498], pitch: -1.1 }));
  const start=await page.evaluate(()=>__b0RenderedFrames);
  await page.waitForFunction(start=>__b0RenderedFrames>start+32,start,{timeout:180000});
  const result = await page.evaluate(() => ({ failures: __glFailures, volume: NMS.volumeState() }));
  await mkdir('test-results/b4-gl-error', { recursive: true });
  await writeFile('test-results/b4-gl-error/report.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.failures, null, 2));
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
