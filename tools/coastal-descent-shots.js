import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startServer } from './server.js';
import { resolveSystemChromePath } from './browser.js';

// One ordinary scene and one coast. Only the initial placement teleports.
// Each following frame goes through the game's continuous flight update;
// at the dry endpoint the normal landing control takes over.
const out = resolve(process.argv[2] || 'test-results/coastal-descent');
const prior = process.argv[3] && process.argv[3] !== '-' ? JSON.parse(await readFile(process.argv[3], 'utf8')).route : null;
await mkdir(out, { recursive: true });
const { server, port } = await startServer(0);
const browser = await chromium.launch({ executablePath: resolveSystemChromePath(), headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (/shader error/i.test(m.text())) errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${port}/?nohero=1${process.argv[4] === 'clear' ? '&weather=clear' : ''}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 180000 });
  await page.addStyleTag({ content: 'body > *:not(#app) { visibility:hidden !important }' });
  const route = await page.evaluate(async prior => {
    const { coastalApproach } = await import('/src/coastal-approach.js');
    const planet = NMS._planet(0);
    const course = coastalApproach(planet, prior || undefined);
    NMS.teleport(0, 0.12, course.pose(75000, 0, 90000, -0.85, 0));
    NMS.setLocalSunAltitude(0, 26, { azimuthHint: course.along });
    window.coastalPose = (...params) => {
      const pose = course.pose(...params);
      NMS.setContinuousAtmosphereAltitude(0, 0, pose);
      const direction = new NMS._THREE.Vector3(...pose.dir);
      return { clearance: pose.clearance, ground: planet.height(direction, planet.fullMaxFreq),
        seaLevel: planet.seaLevel, state: NMS.state, dir: pose.dir };
    };
    return course.route;
  }, prior);
  if (process.argv.includes('--video')) {
    await page.evaluate(() => {
      const stream = NMS._internals.renderer.domElement.captureStream(30);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 6500000 });
      const chunks = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      window.finishCoastalVideo = () => new Promise(resolve => {
        recorder.onstop = () => {
          const link = document.createElement('a');
          link.download = 'coastal-descent.webm';
          link.href = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
          link.click();
          stream.getTracks().forEach(track => track.stop());
          resolve();
        };
        recorder.stop();
      });
      recorder.start();
    });
  }
  const stops = [
    ['01-orbit', 75000, 0, 90000, -0.85, 0],
    ['02-bay', 17000, 0, 8500, -0.54, 0],
    ['03-shelf', 3200, 0, 470, -0.35, 0.22],
    ['04-skim', 850, 0, 22, -0.23, 0.7],
    ['05-surf', 850 * (1 - route.surfFraction), route.surfFraction, 18, -0.32, 0.95],
    ['06-terrace', 0, 1, 42, -0.16, 2.5],
  ];
  let previous = stops[0].slice(1);
  const samples = [];
  for (const [name, ...next] of stops) {
    const sample = await page.evaluate(async ({ previous, next }) => {
      let sample;
      for (let i = 1; i <= 160; i++) {
        const t = i / 160;
        const point = next.map((v, k) => previous[k] + (v - previous[k]) * t);
        sample = window.coastalPose(...point);
        await new Promise(requestAnimationFrame);
      }
      return sample;
    }, { previous, next });
    await page.screenshot({ path: `${out}/${name}.png` });
    samples.push({ name, ...sample });
    previous = next;
    console.log(name, Math.round(sample.ground - sample.seaLevel));
  }
  assert(samples[3].ground < samples[3].seaLevel, 'Low flight must cross open water');
  assert(Math.abs(samples[4].ground - samples[4].seaLevel + 2) < 0.2, 'Surf stop at two metres depth');
  assert(samples.at(-1).ground > samples.at(-1).seaLevel, 'Dry approach endpoint');
  await page.keyboard.press('KeyL');
  await page.waitForFunction('NMS.state === "landed"', null, { timeout: 90000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${out}/07-landed.png` });
  if (process.argv.includes('--video')) {
    const download = page.waitForEvent('download');
    await page.evaluate(() => window.finishCoastalVideo());
    await (await download).saveAs(`${out}/coastal-descent.webm`);
  }
  await writeFile(`${out}/report.json`, JSON.stringify({ route, samples, landed: true, errors }, null, 2));
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  server.close();
}
