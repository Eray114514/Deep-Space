// All four fields have slots; the GPU mask clips unused tile/field instances.
// Reusing these pages in order bounds memory without reading a mask on CPU.
export function planCloudLightBatches({width,height,budgetBytes=64*1024*1024,
  beamBytes=4,maxBatchTiles=128,maxTextureSize=16384,legacyRadiance=false,fusedDensity=false}) {
  for(const value of [width,height,maxBatchTiles,maxTextureSize])
    if(!Number.isSafeInteger(value)||value<1)throw Error('Invalid cloud batch dimensions');
  if(!Number.isSafeInteger(budgetBytes)||budgetBytes<0||![2,4].includes(beamBytes))
    throw Error('Invalid cloud batch budget');
  const tilesX=Math.ceil(width/16),tilesY=Math.ceil(height/16),tileCount=tilesX*tilesY;
  const baseBytes=legacyRadiance?width*height*29+tileCount*4:width*height*20+tileCount;
  const slots=(count,height)=>{
    const columns=Math.min(64,count,Math.floor(maxTextureSize/16));
    if(!columns)return null;
    const rows=Math.ceil(count/columns);
    return rows*height>maxTextureSize?null:{width:columns*16,height:rows*height,columns};
  };
  if(fusedDensity) {
    if(legacyRadiance)throw Error('Fused density requires compact cloud batches');
    for(let rows=Math.min(tilesY,Math.floor(maxBatchTiles/tilesX));rows>=1;rows--) {
      const batchTiles=rows*tilesX, stripeHeight=Math.min(height,rows*16);
      const light=slots(batchTiles*4,256);
      const baseBytes=width*height*16+width*stripeHeight*68+batchTiles;
      const residentBytes=light?baseBytes+light.width*light.height*beamBytes:Infinity;
      if(width<=maxTextureSize&&height<=maxTextureSize&&residentBytes<=budgetBytes)
        return {direct:false,width,height,tilesX,tilesY,tileCount,batchTiles,batches:Math.ceil(tilesY/rows),
          beamBytes,budgetBytes,baseBytes,residentBytes,light,stripe:{rows,height:stripeHeight}};
    }
    return {direct:true,width,height,budgetBytes,residentBytes:0};
  }
  const measure=count=>{
    const metadata=slots(count,16),light=slots(count*4,256);
    if(!metadata||!light)return null;
    return {metadata,light,residentBytes:baseBytes+metadata.width*metadata.height*64+light.width*light.height*beamBytes};
  };
  const minimum=measure(1);
  if(width>maxTextureSize||height>maxTextureSize||!minimum||minimum.residentBytes>budgetBytes)
    return {direct:true,width,height,budgetBytes,residentBytes:0,requiredMinimumBytes:minimum?.residentBytes??baseBytes};
  let lo=1,hi=Math.min(tileCount,maxBatchTiles);
  while(lo<hi) {
    const mid=Math.ceil((lo+hi)/2),candidate=measure(mid);
    if(candidate&&candidate.residentBytes<=budgetBytes)lo=mid;else hi=mid-1;
  }
  return {direct:false,width,height,tilesX,tilesY,tileCount,batchTiles:lo,batches:Math.ceil(tileCount/lo),
    beamBytes,budgetBytes,baseBytes,...measure(lo)};
}
