// WebGL title-screen -> flight hand-off regression.
//
// The ship must start moving immediately, follow one monotonic pull-back, and
// discover no new shader programs after the player presses "开始游戏". Those
// are the two player-visible causes of the old pause-then-pop entrance.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchBrowser,launchHardwareBrowser,resolveSystemChromePath } from './browser.js';
import { startServer } from './server.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import {execFileSync} from 'node:child_process';

const fingerprint=await evidenceFingerprint('tools/hero-playtest.js');
const reference=process.argv.includes('--reference-prewarm');
const hardware=process.argv.includes('--hardware'),traceGL=process.argv.includes('--trace-gl');

const outputDir = path.resolve('screenshots/halcyon');
await mkdir(outputDir, { recursive: true });

let browser;
let server;
const failures = [];
const check = (condition, message) => {
  if (condition) console.log(`✓ ${message}`);
  else {
    failures.push(message);
    console.error(`✗ ${message}`);
  }
};

try {
  const started = await startServer(0);
  server = started.server;
  browser = hardware?await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined,headless:true})
    :await launchBrowser({headless:true});
  const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
  if(traceGL)await page.addInitScript(()=>{
    const original=HTMLCanvasElement.prototype.getContext,installed=new WeakSet();window.__heroGLErrors=[];
    HTMLCanvasElement.prototype.getContext=function(...args) {
      const gl=original.apply(this,args);
      if(!gl?.getError || installed.has(gl))return gl;installed.add(gl);
      const getError=gl.getError.bind(gl),locations=new WeakMap(),names=new Set();
      for(let prototype=Object.getPrototypeOf(gl);prototype&&prototype!==Object.prototype;prototype=Object.getPrototypeOf(prototype))
        for(const name of Object.getOwnPropertyNames(prototype))if(typeof gl[name]==='function'&&name!=='getError'&&name!=='constructor')names.add(name);
      for(const name of names) {
        const method=gl[name].bind(gl);gl[name]=(...values)=>{
          const result=method(...values);
          if(name==='getUniformLocation'&&result)locations.set(result,values[1]);
          const error=getError();
          if(error)window.__heroGLErrors.push({name,error,args:values.map(value=>
            typeof value==='object'?locations.get(value)||(ArrayBuffer.isView(value)?{length:value.length}
              :value instanceof HTMLImageElement?{src:value.src,width:value.naturalWidth,height:value.naturalHeight,complete:value.complete}
              :value?.width!==undefined?{type:value.constructor.name,width:value.width,height:value.height,id:value.id||null}:null)
              :typeof value==='string'?value.slice(0,100):value),stack:new Error().stack});
          return result;
        };
      }
      return gl;
    };
  });
  if(reference)await page.route('**/src/main.js*',route=>route.fulfill({contentType:'text/javascript',
    body:execFileSync('git',['show','ebef3ed:src/main.js'],{encoding:'utf8'})}));
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });

  const url = `http://127.0.0.1:${started.port}/?quality=low&post=0&vclouds=0&farflora=0`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.NMS?.booted === true', null, { timeout: 150000 });
  await page.click('#hero-splash');
  await page.waitForFunction(() => {
    const hero = document.querySelector('#hero-overlay');
    const start = document.querySelector('#hero-start-btn');
    return hero && start && !hero.classList.contains('hidden') && !start.disabled;
  }, null, { timeout: 10000 });
  await page.waitForTimeout(900);

  const before = await page.evaluate(() => ({
    programs: NMS._renderer.info.programs?.length || 0,
    programIds: (NMS._renderer.info.programs || []).map((program) => program.id),
    programKeys: (NMS._renderer.info.programs || []).map((program) => program.cacheKey || ''),
    offset: NMS._internals.ship.introOffset.length(),
  }));
  await page.evaluate((programIds) => {
    window.__heroProgramIds = programIds;
    const trace = { startedAt: 0, clickedAt: 0, frames: [] };
    window.__heroPlaytest = trace;
    const sample = (now) => {
      trace.frames.push({
        elapsed: now - trace.startedAt,
        offset: NMS._internals.ship.introOffset.length(),
        programs: NMS._renderer.info.programs?.length || 0,
        heroActive: document.body.classList.contains('hero-active'),
      });
      if (now - trace.startedAt < 3800) requestAnimationFrame(sample);
    };
    document.querySelector('#hero-start-btn')?.addEventListener('click', () => {
      trace.clickedAt=performance.now();trace.startedAt=trace.clickedAt;
      requestAnimationFrame(sample);
    }, {capture:true,once:true});
  }, before.programIds);
  await page.click('#hero-start-btn');
  await page.waitForFunction(() => !document.body.classList.contains('hero-active')
    && NMS._internals.ship.introOffset.length() < 0.001, null, { timeout: 30000 });
  await page.waitForTimeout(900);

  const result = await page.evaluate(() => ({
    frames: window.__heroPlaytest.frames,
    programs: NMS._renderer.info.programs?.length || 0,
    newPrograms: (NMS._renderer.info.programs || [])
      .filter((program) => !window.__heroProgramIds?.includes(program.id))
      .map((program) => ({ id: program.id, name: program.name || '', cacheKey: program.cacheKey || '' })),
    clickedAt: window.__heroPlaytest.clickedAt,
    startedAt: window.__heroPlaytest.startedAt,
    offset: NMS._internals.ship.introOffset.length(),
  }));
  const offsets = result.frames.map((frame) => frame.offset);
  const clickElapsed = result.clickedAt - result.startedAt;
  const earlyMotion = result.frames.some((frame) => frame.elapsed >= clickElapsed
    && frame.elapsed - clickElapsed <= 850
    && frame.offset < before.offset - 0.1);
  const monotonic = offsets.every((value, index) => index === 0
    || value <= offsets[index - 1] + 0.025);

  check(before.offset > 120 && earlyMotion,
    'hero ship moves during the opening 850 ms instead of waiting then popping');
  check(monotonic && result.offset < 0.001,
    'hero ship follows one monotonic path into formation');
  check(result.programs === before.programs && result.newPrograms.length === 0,
    `hero click creates no shader programs (${before.programs} before / ${result.programs} after)`);
  if (result.programs !== before.programs) {
    console.log('new hero programs:', result.newPrograms);
    for (const program of result.newPrograms.filter((item) => item.cacheKey.includes('dress|'))) {
      const suffix = program.cacheKey.slice(program.cacheKey.indexOf('dress|'));
      const oldKey = before.programKeys.find((key) => key.endsWith(suffix));
      if (!oldKey) continue;
      const oldParts = oldKey.split(',');
      const newParts = program.cacheKey.split(',');
      console.log('matching prewarm variant differs at:', newParts
        .map((value, index) => value === oldParts[index] ? null : `${index}:${oldParts[index]}=>${value}`)
        .filter(Boolean));
    }
  }
  check(pageErrors.length === 0, `hero hand-off has no page errors (${pageErrors.length})`);

  const after=await evidenceFingerprint('tools/hero-playtest.js');
  const {gl,glErrors,adapter}=await page.evaluate(()=>{
    const context=NMS._renderer.getContext(),ext=context.getExtension('WEBGL_debug_renderer_info');
    return {gl:context.getError(),glErrors:window.__heroGLErrors||[],adapter:ext?context.getParameter(ext.UNMASKED_RENDERER_WEBGL):null};
  });
  check(gl===0,`hero hand-off has no WebGL error (${gl})`);
  check(glErrors.length===0,`traced GL calls have no errors (${glErrors.length})`);
  check(fingerprint.sourceDigest===after.sourceDigest,'runtime remains fixed during hero hand-off');
  await mkdir('test-results/hero-handoff',{recursive:true});
  await writeFile(`test-results/hero-handoff/${traceGL?'trace':reference?'reference':'report'}.json`,JSON.stringify({fingerprint,after,url,reference,hardware,traceGL,
    before,result,earlyMotion,monotonic,errors:pageErrors,gl,glErrors,adapter,failures},null,2));

  await page.screenshot({
    path: path.join(outputDir, '00-hero-handoff.png'),
    fullPage: false,
  });
} finally {
  await browser?.close();
  server?.close();
}

if (failures.length) {
  throw new Error(`Hero hand-off failed: ${failures.join('; ')}`);
}
console.log('DONE - hero hand-off is continuous and prewarmed');
