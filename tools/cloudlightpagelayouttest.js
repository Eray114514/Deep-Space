import assert from 'node:assert/strict';
import {planLightPages} from './cloud-light-page-layout.js';
const width=1178,height=662,count=Math.ceil(width/16)*Math.ceil(height/16);
const masks=Uint8Array.from({length:count},(_,i)=>i%5===0?15:i%7===0?1:0);
const full=planLightPages({width,height,tileMasks:masks,budgetBytes:128*1024*1024,beamBytes:2});
assert.equal(full.direct,false);assert.equal(full.overflowTiles,0);
const limited=planLightPages({width,height,tileMasks:masks,budgetBytes:32*1024*1024,beamBytes:2});
assert.ok(limited.overflowTiles>0);assert.ok(limited.metadataCount>0);assert.ok(limited.residentBytes<=limited.budgetBytes);
for(const plan of [full,limited])for(let tile=0;tile<count;tile++)for(let field=0;field<4;field++){
  const slot=plan.lightMap[tile*4+field];
  if(!plan.metaMap[tile])assert.equal(slot,0,'Overflow never exposes a partial field');
  else if(masks[tile]&(1<<field)){
    assert.ok(slot>0);assert.deepEqual(Array.from(plan.lightJobTable.slice((slot-1)*4,slot*4)),
      [tile+1,field,plan.metaMap[tile],0]);
  } else assert.equal(slot,0);
}
const direct=planLightPages({width,height,tileMasks:masks,budgetBytes:1});
assert.equal(direct.direct,true);assert.equal(direct.residentBytes,0);
const smallDevice=planLightPages({width:64,height:64,tileMasks:new Uint8Array(16).fill(15),maxTextureSize:256,budgetBytes:1e7});
assert.ok(smallDevice.overflowTiles>0);assert.ok(smallDevice.light.height<=256);
assert.throws(()=>planLightPages({width,height,tileMasks:new Uint8Array(1)}));
assert.throws(()=>planLightPages({width:1,height:1,tileMasks:new Uint8Array([16])}));
console.log('PASS exact field mapping, padded allocation budget, all-or-nothing overflow, direct fallback and device dimensions.');
