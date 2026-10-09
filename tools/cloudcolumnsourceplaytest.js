// Actual home-world forecasts through the bank, compared to an independent
// standalone column bake. Small output footprint controls cost; source weather
// and density are production inputs. This is not the 1024x512 budget gate.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';

const out='test-results/cloud-column-source',before=await evidenceFingerprint('tools/cloudcolumnsourceplaytest.js');
const {server,port}=await startServer(0);let browser;
await mkdir(out,{recursive:true});
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath(),headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&freeze=1&time=9.5&scene=lowflight&alt=400&planet=0&bias=meadow&quality=balanced&vclouds=1&post=1`);
  await page.waitForFunction(()=>NMS?.booted,null,{timeout:180000});
  await page.waitForFunction(()=>{
    const stream=NMS._planet(0).weatherStream;
    return stream?.ready && stream.frames.has(stream.anchor+2*stream.frameHours);
  },null,{timeout:60000});
  console.log('Real forecast pair ready; testing column snapshots and native MRT output.');
  const result=await page.evaluate(async()=>{
    const {CloudColumnBank}=await import('/src/cloud/cloud-column-bank.js');
    const {CloudColumnMap}=await import('/src/cloud/cloud-column-map.js');
    const p=NMS._planet(0),r=NMS._renderer,stream=p.weatherStream;
    const options={width:32,rows:8,footprintSamples:4},bank=new CloudColumnBank(p,options);
    const saved=r.getRenderTarget(),face=r.getActiveCubeFace(),mip=r.getActiveMipmapLevel();
    const read=map=>{
      const optical=new Uint8Array(32*16*4),heights=new Uint16Array(32*16*4);
      r.readRenderTargetPixels(map.target,0,0,32,16,optical);
      r.readRenderTargetPixels(map.target,0,0,32,16,heights,undefined,1);
      return [optical,heights];
    };
    const difference=(a,b)=>a.reduce((sum,plane,k)=>sum+plane.reduce((n,v,i)=>n+(v!==b[k][i]?1:0),0),0);
    let maxPending=0,maxSnapshotBytes=0,readyTicks=0;
    const update=()=>{
      bank.update(r);
      const pending=[...bank.maps.values()].filter(map=>!map.ready);
      maxPending=Math.max(maxPending,pending.length);
      maxSnapshotBytes=Math.max(maxSnapshotBytes,pending.reduce((n,map)=>n+
        map.snapshots.reduce((bytes,t)=>bytes+t.image.data.byteLength,0),0));
      readyTicks++;
    };
    let reference,lease;
    try {
      while(bank.maps.size<3 || [...bank.maps.values()].some(map=>!map.ready)) {
        if(readyTicks>12)throw Error('Column bank did not finish');update();
      }
      const a=stream.anchor,original=bank.maps.get(a),next=bank.maps.get(a+stream.frameHours);
      const before=read(original),nextBefore=read(next);
      reference=new CloudColumnMap(p,{...options,hours:a});while(!reference.ready)reference.bakeSlice(r,8);
      const referenceChanged=difference(before,read(reference));reference.dispose();reference=null;
      const source=stream.frames.get(a);stream.frames.set(a,{...source});stream.update(p.weatherHours,true);
      update();
      const replacementRejected=original.disposed && !bank.maps.get(a).ready
        && p.volCloudMat.uniforms.uColumnsReady.value===0 && bank.maps.get(a+stream.frameHours)===next;
      update();
      const replacementChanged=difference(before,read(bank.maps.get(a))),nextChanged=difference(nextBefore,read(next));
      lease=bank.programs.columns;
      const ready=p.volCloudMat.uniforms.uColumnsReady.value;
      const released=[...bank.maps.values()].every(map=>map.snapshots.length===0 && map.material===null)
        && Object.keys(lease.uniforms).length===0;
      const occupied=before[0].filter((v,i)=>i%4<2 && v>0).length;
      return {options,weatherSize:p.cloudSpeciesTex.image.width,maxPending,maxSnapshotBytes,
        eagerSnapshotBytes:maxSnapshotBytes*3,readyTicks,referenceChanged,replacementRejected,
        replacementChanged,nextChanged,ready,released,occupied,gl:r.getContext().getError()};
    } finally {
      reference?.dispose();bank.dispose();r.setRenderTarget(saved,face,mip);
    }
  });
  // Booted alone can precede the first composed frame. Capture a known player
  // pose after real frames, rather than a HUD-only initial empty-space image.
  await page.waitForFunction(()=>NMS._pipeline.volumePass.frame>=4,null,{timeout:180000});
  await page.screenshot({path:`${out}/player.png`});
  const player=await page.evaluate(()=>({pose:NMS.referenceState(),volume:NMS.volumeState(),
    gl:NMS._renderer.getContext().getError(),scope:'frozen normal HUD/post lowflight after actual composed frames; reduced columns used only in preceding private diagnostic'}));
  const after=await evidenceFingerprint('tools/cloudcolumnsourceplaytest.js');
  await writeFile(`${out}/report.json`,JSON.stringify({before,after,result,player,errors},null,2));
  assert.equal(before.sourceDigest,after.sourceDigest);assert.deepEqual(errors,[]);
  assert.equal(result.maxPending,1);assert.ok(result.maxSnapshotBytes>1000000 && result.occupied>100);
  assert.equal(result.referenceChanged,0);assert.equal(result.replacementChanged,0);assert.equal(result.nextChanged,0);
  assert.equal(result.ready,1);assert.ok(result.replacementRejected && result.released);
  assert.equal(result.gl,0);assert.equal(player.gl,0);
  console.log(JSON.stringify(result));
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
