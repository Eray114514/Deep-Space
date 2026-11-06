// Tool-only full Far point/cached/merge numerical experiment. Never enabled in
// the runtime. Candidate KHR deadline stays 120s; reference may wait up to240s
// solely to obtain the original single-program numerical result.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';

const verifier='tools/cloudfarsplitgputest.js',helpers=['tools/cloud-far-split-shaders.js','tools/cloud-far-split-browser.js'];
const args=process.argv.slice(2);assert.ok(args.every(arg=>arg==='--reference-first'||/^--union=[01]$/.test(arg)),'Only --reference-first and --union=0|1 are supported');
const union=Number(args.find(arg=>arg.startsWith('--union='))?.slice(8)??1),referenceFirst=args.includes('--reference-first');
const before=await evidenceFingerprint(verifier),hash=b=>createHash('sha256').update(b).digest('hex');
const frozen=new Map(await Promise.all([verifier,...helpers].map(async path=>[path,await readFile(path)])));
const out=`test-results/cloud-far-split/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});for(const [path,bytes]of frozen)await writeFile(`${out}/${path.slice(6)}`,bytes);
const {server,port}=await startServer(0);let browser,page,result;const errors=[],warnings=[];
try{
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  page=await browser.newPage({viewport:{width:1100,height:900}});
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());else if(m.type()==='warning')warnings.push(m.text());});
  await page.route('**/cloud-far-split.html',route=>route.fulfill({contentType:'text/html',body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>'
    +'<style>body{background:#14202b;color:white;font:15px sans-serif}.row{display:flex;gap:20px;align-items:center}canvas{width:384px;height:288px;image-rendering:pixelated}p{width:320px}</style>'
    +'<h2>Full production Far shader split experiment</h2><p>One controlled real Planet; raw FP32 point/cached then the original mix and threshold. Not a normal-player screenshot.</p>'}));
  await page.goto(`http://127.0.0.1:${port}/cloud-far-split.html`);
  console.log(JSON.stringify({out,status:'started',union,referenceFirst,candidateDeadlineMs:120000,referenceNumericalLimitMs:240000}));
  result=await page.evaluate(async options=>{const {probeCloudFarSplit}=await import('/tools/cloud-far-split-browser.js');return probeCloudFarSplit(options);},{union,referenceFirst});
  await page.screenshot({path:`${out}/comparison.png`,fullPage:true});
  assert.equal(result.passed,true);assert.equal(result.gl,0);assert.equal(result.finalGL,0);assert.equal(result.lost,false);assert.equal(result.finalLost,false);
  assert.equal(result.retirement.pending,0);assert.deepEqual(result.retirement.faults,[]);assert.deepEqual(errors,[]);
  assert.deepEqual(warnings.filter(w=>/GL_INVALID_|CONTEXT_LOST|Program object expected/.test(w)),[]);
  const after=await evidenceFingerprint(verifier);assert.deepEqual(after,before);
  for(const [path,bytes]of frozen)assert.deepEqual(await readFile(path),bytes);
  await writeFile(`${out}/report.json`,JSON.stringify({before,after,installedInRuntime:false,union,referenceFirst,
    helperHashes:Object.fromEntries(helpers.map(path=>[path,hash(frozen.get(path))])),result,errors,warnings,passed:true},null,2));
  console.log(JSON.stringify({out,passed:true,preparations:result.preparations,controls:result.controls,timing:result.timing,
    records:result.records.map(r=>({name:r.name,weights:r.weights,formats:r.formats.map(f=>({format:f.format,...f.comparison,nativeChanged:f.nativeChanged})),wrongOver:r.wrongOver}))}));
}catch(error){
  if(page&&!result)try{result=await page.evaluate(()=>window.__cloudFarSplit||null);}catch{}
  await writeFile(`${out}/failure.json`,JSON.stringify({before,union,referenceFirst,result,errors,warnings,error:String(error),stack:error.stack},null,2));throw error;
}finally{await browser?.close();server.close();}
