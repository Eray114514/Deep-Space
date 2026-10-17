// Local, persistent visual attribution harness. Commands and output stay in
// ignored test-results; final acceptance uses the reproducible suites instead.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
const root = 'test-results/b4-rework/lab';
await mkdir(root, { recursive: true });
const baseline = JSON.parse(await readFile('docs/baselines/b4-local-2026-09-27/manifest.json'));
const { server, port } = await startServer(0);
const browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath(), headless: true });
try {
  let errors = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  page.on('pageerror', e => { errors.push(String(e)); console.error(String(e)); });
  page.on('console', m => { if (m.type() === 'error') { errors.push(m.text()); console.error(m.text()); } });
  await page.route('**/src/clouds-webgl.js?*', async route => {
    const response = await route.fetch();
    const version = new URL(route.request().url()).search;
    const body = (await response.text())
      .replace("'./cloud/production-medium-glsl.js'", `'./cloud/production-medium-glsl.js${version}'`)
      .replace("'./cloud/weather-atlas.js'", `'./cloud/weather-atlas.js${version}'`);
    await route.fulfill({ response, body });
  });
  await page.goto(`http://127.0.0.1:${port}/?quality=ultra&freeze=1&time=9.5&nohero=1&vclouds=1&post=1&nolock=1`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 180000 });
  await page.evaluate(async () => {
    window.B0 = await import('/tools/b0-browser.js'); B0.installCaptureHold(); NMS.setAdaptiveQualityLocked(true);
  });
  console.log('Cloud lab ready.');
  const bootErrors=errors.slice();
  // Ignore the previous run's command (including its stop request). The next
  // operator supplies a new id after this process reports that it is ready.
  let last = null;
  try { last = JSON.parse(await readFile(`${root}/command.json`, 'utf8')).id; } catch {}
  while (true) {
    let command;
    try { command = JSON.parse(await readFile(`${root}/command.json`, 'utf8')); } catch { await delay(400); continue; }
    if (command.id === last) { await delay(400); continue; }
    last = command.id;
    if (command.stop) break;
    try {
      errors = bootErrors.slice();
      if(command.restart) {
        await page.reload();
        await page.waitForFunction('window.NMS?.booted',null,{timeout:180000});
        await page.evaluate(async()=>{
          window.B0=await import('/tools/b0-browser.js');B0.installCaptureHold();NMS.setAdaptiveQualityLocked(true);
        });
      }
      if (command.reload) await page.evaluate(async id => {
        const { makeCloudVolumeMaterial } = await import(`/src/clouds-webgl.js?lab=${id}`);
        const oldScattering=new Set();
        for (const p of NMS._internals.universe.system.planets) {
          if (!p.volCloudMat) continue;
          const old = p.volCloudMat, u = old.uniforms;
          // Fixture changes update the live material topology; the original
          // shell descriptor can still carry its authored localWeather value.
          const band={...p.volCloudBand,localWeather:old.defines.PRODUCTION_CLOUD_MEDIUM===1};
          const candidate = makeCloudVolumeMaterial(p, band, u.uCloudNoise.value,
            p.cloudShadowTex, p.cloudWeatherHiTex, { steps: u.uMaxSteps.value });
          if (candidate.uniforms.uNoise3.value !== u.uNoise3.value) candidate.uniforms.uNoise3.value.dispose();
          old.fragmentShader = candidate.fragmentShader;
          old.vertexShader = candidate.vertexShader;
          old.defines = candidate.defines;
          if(u.uCloudScattering)oldScattering.add(u.uCloudScattering.value);
          u.uCloudScattering=candidate.uniforms.uCloudScattering;
          for (const [key, value] of Object.entries(candidate.uniforms)) if (!u[key]) u[key] = value;
          old.needsUpdate = true; candidate.dispose();
          if(p.volCloudFarMat) {
            p.volCloudFarMat.fragmentShader=old.fragmentShader;
            p.volCloudFarMat.vertexShader=old.vertexShader;
            p.volCloudFarMat.defines={...old.defines,CLOUD_FAR_VIEW:1};
            p.volCloudFarMat.uniforms=old.uniforms;
            p.volCloudFarMat.needsUpdate=true;
          }
        }
        for(const texture of oldScattering)texture.dispose();
        NMS._pipeline.volumePass.resetHistory();
      }, command.id);
      const evaluation=command.evaluate?await page.evaluate(command.evaluate):null;
      if(command.evaluate)console.log((JSON.stringify(evaluation) ?? 'undefined').slice(0,4000));
      const captures = [];
      const index = command.index ?? 0, light = command.light || 'day';
      const column = command.column || (command.evaluationColumn ? evaluation.column : null)
        || (command.speciesId
          ? await page.evaluate(({index,light,speciesId})=>B0.occupiedColumn(index,
            light==='day'?55:light==='twilight'?0:-25,{speciesId}),{index,light,speciesId:command.speciesId})
          : baseline.columns.find(c => c.index === index && c.light === light));
      for (const scene of command.scenes || []) {
        await page.evaluate(({ index, column, scene }) => {
          window.__b0Exposure = null; B0.cloudPose(index, column, scene);
        }, { index, column, scene });
        await page.waitForTimeout(1200);
        for (const variant of command.variants || ['normal']) {
          await page.evaluate(({ index, variant }) => {
            NMS.setAtmosphereVisible(variant !== 'air-off'); NMS.setCloudsVisible(variant !== 'clouds-off', index);
            NMS._pipeline.volumePass.resetHistory();
          }, { index, variant });
          const start = await page.evaluate(() => __b0RenderedFrames);
          await page.waitForFunction(start => __b0RenderedFrames > start + 32, start, { timeout: 180000 });
          const name = `${command.id}-p${index}-${light}-${scene}-${variant}.png`;
          await page.screenshot({ path: `${root}/${name}` });
          const state=await page.evaluate(index => B0.snapshot(index), index);
          captures.push({ path: name, state });
          if(state.render.webglError)errors.push(`${name}: WebGL error ${state.render.webglError}`);
          console.log(name);
        }
      }
      await writeFile(`${root}/${command.id}.json`, JSON.stringify({ command, evaluation, captures, errors }, null, 2));
      if (errors.length) throw Error(errors.join('\n'));
      console.log(`Completed ${command.id}`);
    } catch (error) { console.error(error); await writeFile(`${root}/${command.id}-error.txt`, String(error)); }
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
