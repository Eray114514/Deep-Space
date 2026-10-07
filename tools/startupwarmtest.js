import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';
const out='test-results/startup-warm',before=await evidenceFingerprint('tools/startupwarmtest.js');
const {server,port}=await startServer(0);let browser;
await mkdir(out,{recursive:true});const errors=[];
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  const page=await browser.newPage({viewport:{width:1280,height:720}});
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  const source=await readFile('src/main.js','utf8');
  const delayed=source.replace('const tasks = [renderer.compileAsync(surfaceBootstrapGroup, camera, scene)];',
    'const tasks = [renderer.compileAsync(surfaceBootstrapGroup, camera, scene).then(()=>new Promise(resolve=>setTimeout(resolve,22000)))];');
  assert.notEqual(delayed,source,'Control must delay the actual surface warmup completion');
  await page.route('**/src/main.js*',route=>route.fulfill({contentType:'text/javascript',body:delayed}));
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&freeze=1&time=9.5&scene=walk&planet=0&bias=meadow&quality=balanced&vclouds=0&post=1`);
  await page.waitForFunction(()=>NMS?.booted,null,{timeout:90000});
  await page.waitForFunction(()=>NMS.surfaceWarmupState().expired,null,{timeout:10000});
  await page.waitForFunction(()=>NMS.stats().grass>20,null,{timeout:60000});
  await page.waitForTimeout(24000);
  const result=await page.evaluate(()=>({warmup:NMS.surfaceWarmupState(),stats:NMS.stats(),
    gl:NMS._renderer.getContext().getError(),scope:'Surface completion deliberately delayed 22 s; safety release must not allow late optional drawing or retain representatives.'}));
  await page.screenshot({path:`${out}/player.png`});
  const after=await evidenceFingerprint('tools/startupwarmtest.js');
  await writeFile(`${out}/report.json`,JSON.stringify({before,after,result,errors},null,2));
  assert.equal(before.sourceDigest,after.sourceDigest);assert.deepEqual(errors,[]);assert.equal(result.gl,0);
  assert.equal(result.warmup.ready,true);assert.equal(result.warmup.pending,false);
  assert.equal(result.warmup.stats.skipped,true);assert.equal(result.warmup.stats.calls,0);
  assert.equal(result.warmup.remainingMeshes,0);assert.ok(result.stats.grass>20);
  console.log(`PASS: delayed surface warmup cancelled after loading release; real grass rendered, GL 0, no retained representatives; ${out}`);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
