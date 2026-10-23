import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';

const files=['src/presented-frame-stats.js','tools/presentedframestatstest.js'];
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const frozen=new Map(await Promise.all(files.map(async path=>[path,await readFile(new URL(`../${path}`,import.meta.url))])));
const {PresentedFrameStats}=await import('../src/presented-frame-stats.js');
const out=`test-results/presented-frame-pause/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});
for(const [path,bytes] of frozen)await writeFile(`${out}/${path.split('/').at(-1)}`,bytes);
const cases=[];
function test(name,work) {
  try {work();cases.push({name,passed:true});}
  catch(error){cases.push({name,passed:false,error:String(error),actual:error?.actual,expected:error?.expected,stack:error?.stack});}
}
const sample=(elapsedMs,activeMs=elapsedMs,recorded=true)=>({elapsedMs,activeMs,recorded});

// Keep the original eight cadence/window contracts, with explicit pause
// boundaries replacing the old per-submission paused option.
test('skipped animation callbacks never create presented samples',()=>{
  const s=new PresentedFrameStats();assert.equal(s.snapshot().performanceFrames,0);
  assert.deepEqual(s.present(120),sample(120));for(let tick=1;tick<60;tick++)s.snapshot();
  assert.equal(s.snapshot().averageFps,8.3);assert.equal(s.snapshot().performanceFrames,1);
  s.present(240);assert.equal(s.snapshot().performanceWindowSeconds,.24);assert.equal(s.snapshot().longFrames,2);
});
test('an active 109 second stall remains in the performance window',()=>{
  const s=new PresentedFrameStats();s.present(16);s.present(109016);
  assert.equal(s.snapshot().maximumFrameMs,109000);assert.equal(s.snapshot().low1Fps,0);
  assert.equal(s.snapshot().performanceWindowSeconds,109.016);
});
test('submitting while paused advances wall cadence without adding an active sample',()=>{
  const s=new PresentedFrameStats();s.present(20);s.setPaused(true,20);
  assert.deepEqual(s.present(90020),sample(90000,0,false));s.setPaused(false,90020);s.present(90040);
  assert.equal(s.snapshot().performanceFrames,2);assert.equal(s.snapshot().maximumFrameMs,20);
  assert.equal(s.snapshot().averageFps,50);
});
test('opaque map suspension excludes its entire current interval',()=>{
  const s=new PresentedFrameStats();s.present(20);s.suspend(100000);s.present(100020);
  assert.equal(s.snapshot().performanceWindowSeconds,.04);assert.equal(s.snapshot().longFrames,0);
});
test('rolling removal decrements the long-frame count',()=>{
  const s=new PresentedFrameStats({window:3});s.present(100);s.present(120);s.present(140);s.present(160);
  assert.equal(s.snapshot().longFrames,0);assert.equal(s.snapshot().performanceFrames,3);
  assert.equal(s.snapshot().maximumFrameMs,20);
});
test('invalid or nonincreasing submission times do not change accounting',()=>{
  const s=new PresentedFrameStats();s.present(10);
  for(const at of [10,5,NaN,Infinity])assert.equal(s.present(at),null);
  assert.deepEqual(s.present(20),sample(10));assert.equal(s.snapshot().performanceFrames,2);s.suspend(NaN);
  assert.deepEqual(s.present(30),sample(10));
});
test('reset clears samples and starts a new interval',()=>{
  const s=new PresentedFrameStats();s.present(100);s.reset(10000);
  assert.equal(s.snapshot().maximumFrameMs,0);s.present(10020);assert.equal(s.snapshot().averageFps,50);
});
test('the default rolling window retains exactly 600 submitted samples',()=>{
  const s=new PresentedFrameStats();for(let i=1;i<=601;i++)s.present(i*16);
  assert.equal(s.snapshot().performanceFrames,600);assert.equal(s.snapshot().averageFps,62.5);
  assert.equal(s.snapshot().performanceWindowSeconds,9.6);
});

test('pause and resume with no intervening submission exclude the pause but preserve dev cadence',()=>{
  const s=new PresentedFrameStats();s.present(16);s.setPaused(true,20);s.setPaused(false,1000);
  assert.deepEqual(s.present(1016),sample(1000,20));
  assert.equal(s.snapshot().maximumFrameMs,20);assert.equal(s.snapshot().longFrames,0);
  assert.equal(s.snapshot().performanceWindowSeconds,.036);
});
test('multiple pause segments between submissions are all subtracted once',()=>{
  const s=new PresentedFrameStats();s.present(10);s.setPaused(true,20);s.setPaused(false,40);
  s.setPaused(true,60);s.setPaused(false,90);assert.deepEqual(s.present(110),sample(100,50));
  assert.equal(s.snapshot().maximumFrameMs,50);assert.equal(s.snapshot().longFrames,0);
  assert.equal(s.snapshot().performanceWindowSeconds,.06);
});
test('repeated same-state boundaries do not move the original pause start',()=>{
  const s=new PresentedFrameStats();s.setPaused(true,10);s.setPaused(true,20);
  s.setPaused(false,30);s.setPaused(false,40);assert.deepEqual(s.present(50),sample(50,30));
});
test('same-time pause and resume boundaries add no artificial duration',()=>{
  const s=new PresentedFrameStats();s.setPaused(true,5);s.setPaused(true,5);s.setPaused(false,5);
  s.setPaused(false,5);assert.deepEqual(s.present(10),sample(10));
});
test('reset during a pause preserves the pause owner and discards prior accumulated time',()=>{
  const s=new PresentedFrameStats();s.present(16);s.setPaused(true,20);s.reset(10000);
  assert.deepEqual(s.present(10020),sample(20,0,false));s.setPaused(false,10030);
  assert.deepEqual(s.present(10040),sample(20,10));
  assert.equal(s.snapshot().performanceFrames,1);assert.equal(s.snapshot().maximumFrameMs,10);
});
test('explicit reset pause state overrides the prior state',()=>{
  const s=new PresentedFrameStats();s.reset(100,{paused:true});
  assert.deepEqual(s.present(120),sample(20,0,false));s.reset(200,{paused:false});
  assert.deepEqual(s.present(216),sample(16));assert.equal(s.snapshot().performanceFrames,1);
});
test('map suspension while paused resumes pause accounting from the map boundary',()=>{
  const s=new PresentedFrameStats();s.present(10);s.setPaused(true,20);s.suspend(1000);
  s.setPaused(false,1100);assert.deepEqual(s.present(1120),sample(120,20));
  s.setPaused(true,1130);s.suspend(2000);assert.deepEqual(s.present(2050),sample(50,0,false));
  s.setPaused(false,2060);assert.deepEqual(s.present(2070),sample(20,10));
  assert.equal(s.snapshot().performanceFrames,3);assert.equal(s.snapshot().performanceWindowSeconds,.04);
});
test('resuming inside the map cannot reintroduce pre-suspension pause segments',()=>{
  const s=new PresentedFrameStats();s.present(10);s.setPaused(true,20);s.suspend(1000);
  s.setPaused(false,1010);s.suspend(2000);assert.deepEqual(s.present(2020),sample(20));
  assert.equal(s.snapshot().performanceWindowSeconds,.03);
});
test('a zero-active interval remains a real dev submission interval without a performance sample',()=>{
  const s=new PresentedFrameStats();s.setPaused(true,0);s.setPaused(false,1000);
  assert.deepEqual(s.present(1000),sample(1000,0,false));assert.equal(s.snapshot().performanceFrames,0);
  assert.deepEqual(s.present(1016),sample(16));assert.equal(s.snapshot().averageFps,62.5);
});
test('active long stalls across several unsubmitted pause cycles remain visible',()=>{
  const s=new PresentedFrameStats();s.present(16);s.setPaused(true,20);s.setPaused(false,9020);
  s.setPaused(true,19020);s.setPaused(false,20020);
  assert.deepEqual(s.present(119020),sample(119004,109004));
  assert.equal(s.snapshot().maximumFrameMs,109004);assert.equal(s.snapshot().longFrames,1);
});
test('paused submissions discard preceding active time but cannot contaminate the resumed sample',()=>{
  const s=new PresentedFrameStats();s.present(10);s.setPaused(true,20);
  assert.deepEqual(s.present(30),sample(20,10,false));assert.deepEqual(s.present(50),sample(20,0,false));
  s.setPaused(false,60);assert.deepEqual(s.present(80),sample(30,20));
  assert.equal(s.snapshot().performanceFrames,2);assert.equal(s.snapshot().performanceWindowSeconds,.03);
});
test('invalid or backward boundaries and map times leave the current pause intact',()=>{
  const s=new PresentedFrameStats();s.present(10);assert.equal(s.setPaused(true,20),true);
  for(const at of [19,NaN,Infinity])assert.equal(s.setPaused(false,at),false);
  assert.equal(s.suspend(15),false);assert.equal(s.present(19),null);
  assert.deepEqual(s.present(30),sample(20,10,false));s.setPaused(false,40);
  assert.deepEqual(s.present(50),sample(20,10));assert.equal(s.snapshot().performanceFrames,2);
});
test('initially paused construction starts its pause at the supplied initial time',()=>{
  const s=new PresentedFrameStats({initialTime:100,paused:true});
  assert.deepEqual(s.present(120),sample(20,0,false));s.setPaused(false,130);
  assert.deepEqual(s.present(140),sample(20,10));assert.equal(s.snapshot().performanceFrames,1);
});

const sources=[];
for(const [path,bytes] of frozen) {
  const after=await readFile(new URL(`../${path}`,import.meta.url));
  sources.push({path,bytes:bytes.length,sha256:sha256(bytes),stable:sha256(bytes)===sha256(after)});
}
const report={kind:'cpu-contracts',scope:'Actual PresentedFrameStats class; submission cadence, explicit pause boundaries, skipped submissions, map suspension and rolling window. No GPU.',
  passed:cases.filter(item=>item.passed).length,total:cases.length,sources,cases};
await writeFile(`${out}/report.json`,`${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify({out,...report},null,2));
assert.equal(sources.every(item=>item.stable),true,'Presented-frame source changed during contracts');
assert.equal(report.passed,report.total,'Presented-frame contracts failed');
