// Quick regional analysis of parity test screenshots.
// Splits each image into a 4x4 grid and reports mean RGB + diff concentration.
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const scene = process.argv[2] || 'orbit';
const dir = new URL('../test-results/parity/', import.meta.url);

function load(name) {
  return PNG.sync.read(readFileSync(new URL(name, dir)));
}

const webgl = load(`webgl-${scene}.png`);
const webgpu = load(`webgpu-${scene}.png`);
const diff = load(`diff-${scene}.png`);

const w = Math.min(webgl.width, webgpu.width);
const h = Math.min(webgl.height, webgpu.height);
const cols = 4, rows = 4;
const cellW = Math.floor(w / cols), cellH = Math.floor(h / rows);

console.log(`Scene: ${scene}, image: ${w}x${h}, grid: ${cols}x${rows}\n`);
console.log('Grid layout: [row,col]  row 0 = top of image (space), row 3 = bottom');
console.log('Each cell: WebGL mean RGB | WebGPU mean RGB | mean delta | changed% in cell\n');

for (let r = 0; r < rows; r++) {
  let line = '';
  for (let c = 0; c < cols; c++) {
    let wgSum = [0, 0, 0], wpSum = [0, 0, 0], dSum = 0, changed = 0, count = 0;
    for (let y = r * cellH; y < (r + 1) * cellH; y++) {
      for (let x = c * cellW; x < (c + 1) * cellW; x++) {
        const i = (webgl.width * y + x) << 2;
        const j = (webgpu.width * y + x) << 2;
        wgSum[0] += webgl.data[i]; wgSum[1] += webgl.data[i + 1]; wgSum[2] += webgl.data[i + 2];
        wpSum[0] += webgpu.data[j]; wpSum[1] += webgpu.data[j + 1]; wpSum[2] += webgpu.data[j + 2];
        const dr = Math.abs(webgl.data[i] - webgpu.data[j]);
        const dg = Math.abs(webgl.data[i + 1] - webgpu.data[j + 1]);
        const db = Math.abs(webgl.data[i + 2] - webgpu.data[j + 2]);
        const delta = (dr + dg + db) / 3;
        dSum += delta;
        if (delta > 12) changed++;
        count++;
      }
    }
    const wgMean = wgSum.map(s => Math.round(s / count));
    const wpMean = wpSum.map(s => Math.round(s / count));
    const dMean = (dSum / count).toFixed(1);
    const chgPct = ((changed / count) * 100).toFixed(0);
    line += `[${r},${c}] WG(${wgMean.join(',')}) WP(${wpMean.join(',')}) d=${dMean} ${chgPct}%  `;
  }
  console.log(line);
}

// Also report the single biggest delta region
let maxDelta = 0, maxX = 0, maxY = 0;
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const i = (webgl.width * y + x) << 2;
    const j = (webgpu.width * y + x) << 2;
    const delta = (Math.abs(webgl.data[i] - webgpu.data[j]) +
      Math.abs(webgl.data[i + 1] - webgpu.data[j + 1]) +
      Math.abs(webgl.data[i + 2] - webgpu.data[j + 2])) / 3;
    if (delta > maxDelta) { maxDelta = delta; maxX = x; maxY = y; }
  }
}
console.log(`\nMax delta ${maxDelta.toFixed(1)} at (${maxX}, ${maxY}) — grid [${Math.floor(maxY / cellH)},${Math.floor(maxX / cellW)}]`);
