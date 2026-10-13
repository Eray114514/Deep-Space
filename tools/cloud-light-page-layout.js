// Exact-query paging policy, not a coarser spatial light cache. A rejected
// tile owns no partial pages and must use the complete original transport.
export function planLightPages({width,height,tileMasks,budgetBytes=64*1024*1024,
  beamBytes=4,tileSize=16,bins=16,maxTextureSize=16384}) {
  for(const value of [width,height,tileSize,bins,maxTextureSize])
    if(!Number.isSafeInteger(value)||value<1)throw Error('Invalid light-page dimensions');
  if(!Number.isSafeInteger(budgetBytes)||budgetBytes<0||![2,4].includes(beamBytes))throw Error('Invalid light-page budget');
  const tilesX=Math.ceil(width/tileSize),tilesY=Math.ceil(height/tileSize),tileCount=tilesX*tilesY;
  if(tileMasks.length!==tileCount||tileMasks.some(mask=>(mask&~15)!==0))throw Error('Invalid four-field tile masks');
  const slots=(count,w,h)=>{
    if(!count)return {width:1,height:1,capacity:0};
    const columns=Math.min(64,count,Math.floor(maxTextureSize/w));
    if(!columns)return null;
    const rows=Math.ceil(count/columns);
    return rows*h>maxTextureSize?null:{width:columns*w,height:rows*h,capacity:columns*rows};
  };
  const table=count=>{const width=Math.max(1,Math.min(256,count));return {width,height:Math.max(1,Math.ceil(count/width))};};
  const baseBytes=width*height*29+tileCount*24;
  const measure=(metaCount,lightCount)=>{
    const metadata=slots(metaCount,tileSize,tileSize),light=slots(lightCount,tileSize,tileSize*bins);
    if(!metadata||!light)return null;
    const metaTable=table(metaCount),lightTable=table(lightCount);
    const bytes=baseBytes+metadata.width*metadata.height*64+light.width*light.height*beamBytes
      +metaTable.width*metaTable.height*4+lightTable.width*lightTable.height*16;
    return {metadata,light,metaTable,lightTable,bytes};
  };
  const initial=measure(0,0);
  if(width>maxTextureSize||height>maxTextureSize||!initial||initial.bytes>budgetBytes)
    return {direct:true,residentBytes:0,requiredBaseBytes:initial?.bytes??baseBytes,budgetBytes,tilesX,tilesY};
  const metaMap=new Uint32Array(tileCount),lightMap=new Uint32Array(tileCount*4),metaJobs=[],lightJobs=[];
  let layout=initial,overflowTiles=0,requestedTiles=0;
  for(let tile=0;tile<tileCount;tile++) {
    const mask=tileMasks[tile];if(!mask)continue;requestedTiles++;
    const fields=[0,1,2,3].filter(field=>(mask&(1<<field))!==0);
    const trial=measure(metaJobs.length+1,lightJobs.length+fields.length);
    if(!trial||trial.bytes>budgetBytes){overflowTiles++;continue;}
    const meta=metaJobs.length+1;metaMap[tile]=meta;metaJobs.push(tile+1);
    for(const field of fields){lightMap[tile*4+field]=lightJobs.length+1;lightJobs.push([tile+1,field,meta,0]);}
    layout=trial;
  }
  const metadataTable=new Uint32Array(layout.metaTable.width*layout.metaTable.height);
  metadataTable.set(metaJobs);
  const lightTable=new Uint32Array(layout.lightTable.width*layout.lightTable.height*4);
  lightJobs.forEach((job,i)=>lightTable.set(job,i*4));
  return {direct:false,tilesX,tilesY,tileSize,bins,beamBytes,budgetBytes,baseBytes,residentBytes:layout.bytes,
    requestedTiles,overflowTiles,metadataCount:metaJobs.length,lightCount:lightJobs.length,
    metadata:layout.metadata,light:layout.light,metaTable:layout.metaTable,lightTable:layout.lightTable,
    metaMap,lightMap,metadataTable,lightJobTable:lightTable};
}
