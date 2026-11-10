import assert from 'node:assert/strict';
import {planCloudLightBatches} from '../src/cloud/cloud-light-batch-layout.js';
for(const [width,height,budget] of [[589,331,8],[1178,662,32],[736,414,64],[17,33,1]]) {
  const plan=planCloudLightBatches({width,height,budgetBytes:budget*1024*1024});
  assert.equal(plan.direct,false);assert.ok(plan.residentBytes<=plan.budgetBytes);
  let covered=0;
  for(let start=0;start<plan.tileCount;start+=plan.batchTiles) {
    const count=Math.min(plan.batchTiles,plan.tileCount-start);
    assert.equal(start,covered);covered+=count;
    assert.ok(plan.metadata.width*plan.metadata.height>=count*256);
    assert.ok(plan.light.width*plan.light.height>=count*4*4096);
  }
  assert.equal(covered,Math.ceil(width/16)*Math.ceil(height/16));
}
assert.equal(planCloudLightBatches({width:589,height:331,budgetBytes:1024*1024}).direct,true);
const compact=planCloudLightBatches({width:1178,height:662,budgetBytes:32*1024*1024});
const legacy=planCloudLightBatches({width:1178,height:662,budgetBytes:32*1024*1024,legacyRadiance:true});
assert.equal(compact.batchTiles,legacy.batchTiles);
assert.equal(legacy.residentBytes-compact.residentBytes,1178*662*9+compact.tileCount*3);
const small=planCloudLightBatches({width:64,height:64,maxTextureSize:256});
assert.equal(small.direct,false);assert.ok(small.light.height<=256);
assert.throws(()=>planCloudLightBatches({width:1,height:1,maxBatchTiles:0}));
console.log('PASS all pixels/fields covered exactly once, reused padded atlases bounded, device limits and direct original path.');
