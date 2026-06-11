// Crop a region of a PNG at native resolution (for inspecting fine detail
// that thumbnail downscaling destroys). Uses playwright's chromium as the
// image decoder so we add no dependencies.
// usage: node tools/crop.js <in.png> <out.png> [x y w h]

import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const [inFile, outFile, x = '0', y = '0', w = '400', h = '400'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) } });
const b64 = (await readFile(inFile)).toString('base64');
await page.setContent(`<body style="margin:0"><img style="position:absolute;left:${-x}px;top:${-y}px" src="data:image/png;base64,${b64}"></body>`);
await page.waitForTimeout(300);
await page.screenshot({ path: outFile });
await browser.close();
console.log(`cropped ${inFile} [${x},${y} ${w}x${h}] -> ${outFile}`);
