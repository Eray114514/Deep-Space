// Verify the cloudTexture canvas compositing in a real Chromium: average
// alpha of the nebula and band variants, corner/center samples, and a
// data-URL dump rendered to PNG for eyeballing.
import { writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl'],
});
const page = await browser.newPage();
const res = await page.evaluate(() => {
  const makeRng = (s0 => { let s = 2166136261 >>> 0; return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) >>> 0) / 4294967296); })();
  function cloudTexture(rand, size = 256, band = false) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = band ? size / 2 : size;
    const H = canvas.height;
    const ctx = canvas.getContext('2d');
    const blobs = band ? 110 : 55;
    for (let i = 0; i < blobs; i++) {
      const bx = rand() * size;
      const by = band ? H * (0.5 + (rand() - 0.5) * 0.6) : rand() * H;
      const br = (band ? 0.04 + rand() * 0.1 : 0.06 + rand() * 0.15) * size;
      const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
      g.addColorStop(0, `rgba(255,255,255,${0.05 + rand() * 0.1})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, H);
    }
    ctx.globalCompositeOperation = 'destination-in';
    if (band) {
      let g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.5, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, H);
      g = ctx.createLinearGradient(0, 0, size, 0);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(0.25, 'rgba(0,0,0,1)');
      g.addColorStop(0.75, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, H);
    } else {
      const g = ctx.createRadialGradient(size / 2, H / 2, size * 0.08, size / 2, H / 2, size * 0.5);
      g.addColorStop(0, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, H);
    }
    return canvas;
  }
  const stats = (cv) => {
    const ctx = cv.getContext('2d');
    const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let sum = 0, max = 0;
    for (let i = 3; i < d.length; i += 4) { sum += d[i]; if (d[i] > max) max = d[i]; }
    const px = (x, y) => d[(y * cv.width + x) * 4 + 3];
    return {
      avgA: (sum / (d.length / 4) / 255).toFixed(3), maxA: (max / 255).toFixed(3),
      corner: px(2, 2), center: px(cv.width >> 1, cv.height >> 1),
    };
  };
  const neb = cloudTexture(makeRng);
  const band = cloudTexture(makeRng, 256, true);
  return {
    neb: stats(neb), band: stats(band),
    nebURL: neb.toDataURL(), bandURL: band.toDataURL(),
  };
});
console.log('nebula:', JSON.stringify(res.neb));
console.log('band  :', JSON.stringify(res.band));
await mkdir('screenshots/v20', { recursive: true });
await writeFile('screenshots/v20/_tex-neb.png', Buffer.from(res.nebURL.split(',')[1], 'base64'));
await writeFile('screenshots/v20/_tex-band.png', Buffer.from(res.bandURL.split(',')[1], 'base64'));
await browser.close();
process.exit(0);
