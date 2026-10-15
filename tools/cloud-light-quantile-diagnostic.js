// Instrumented shader controls are not a substitute for the unchanged Scene
// reference. Always report whether the instrumented HDR reproduces its output.
export function inspectCloudQuantiles(vp,current,reference) {
  const T=NMS._THREE,r=NMS._renderer,stage=vp.lightBatch,owner=stage.source;
  const wanted=[...new Set(Array.from(current.keys()).filter(i=>current[i]!==reference[i]).map(i=>Math.floor(i/4)))];
  const compare=(a,b)=>{let changed=0,max=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i]){changed++;max=Math.max(max,Math.abs(a[i]-b[i]));}return {changed,maximumError:max};};
  const halfCompare=(a,b)=>compare(Array.from(a,T.DataUtils.fromHalfFloat),Array.from(b,T.DataUtils.fromHalfFloat));
  const end='gl_FragColor = vec4(correction * uEngage, alpha);';
  if(!owner.fragmentShader.includes(end))throw Error('Diagnostic output boundary changed');
  const shader='uniform int uDiagMode,uDiagGroup;\n'+owner.fragmentShader.replace(end,end+`
    if(uDiagMode==1)gl_FragColor=vec4(dir,sceneRayLimit());
    if(uDiagMode==2)gl_FragColor=vec4(totalOpacity,t0,t1,jitter);
    if(uDiagMode==3){int k=uDiagGroup*4;gl_FragColor=vec4(anchors[k],anchors[k+1],anchors[k+2],anchors[k+3]);}
  `);
  const material=new T.ShaderMaterial({defines:{...owner.defines},uniforms:{...owner.uniforms,uDiagMode:{value:0},uDiagGroup:{value:0}},
    vertexShader:owner.vertexShader,fragmentShader:shader,side:owner.side,depthTest:owner.depthTest,depthWrite:false,
    transparent:owner.transparent,blending:owner.blending,premultipliedAlpha:owner.premultipliedAlpha});
  const scene=new T.Scene(),mesh=new T.Mesh(stage.mesh.geometry,material);mesh.layers.set(2);mesh.frustumCulled=false;
  mesh.matrixAutoUpdate=false;mesh.matrix.copy(stage.mesh.matrixWorld);scene.add(mesh);scene.updateMatrixWorld(true);
  const target=new T.WebGLRenderTarget(vp.width,vp.height,{type:T.FloatType,depthBuffer:false});
  const half=new T.WebGLRenderTarget(vp.width,vp.height,{type:T.HalfFloatType,depthBuffer:false});
  const draw=(mode,group=0)=>{
    material.uniforms.uDiagMode.value=mode;material.uniforms.uDiagGroup.value=group;
    r.setRenderTarget(mode?target:half);r.clear(true,false,false);r.render(scene,vp.camera);
    const data=mode?new Float32Array(current.length):new Uint16Array(current.length);
    r.readRenderTargetPixels(mode?target:half,0,0,vp.width,vp.height,data);return data;
  };
  const anchors=new Map(wanted.map(pixel=>[pixel,new Array(16)])),rawRender=r.render;
  let captures=0;
  try {
    r.render=function(...args) {
      const result=rawRender.apply(this,args);
      if(args[0]===stage.tileScene&&stage.tileMesh.material===stage.metadataMaterial) {
        const start=stage.page.uBatchStart.value,count=stage.page.uBatchCount.value,columns=stage.plan.metadata.columns;
        for(const pixel of wanted) {
          const x=pixel%vp.width,y=Math.floor(pixel/vp.width),tile=Math.floor(y/16)*stage.plan.tilesX+Math.floor(x/16),slot=tile-start;
          if(slot<0||slot>=count)continue;
          const mx=(slot%columns)*16+x%16,my=Math.floor(slot/columns)*16+y%16;
          for(let group=0;group<4;group++) {
            const values=new Float32Array(4);r.readRenderTargetPixels(stage.metadata,mx,my,1,1,values,undefined,group);
            anchors.get(pixel).splice(group*4,4,...values);captures++;
          }
        }
      }
      return result;
    };
    stage.render(r,vp.camera,vp.activePlanet.volCloudMesh,half);r.render=rawRender;
    const repeated=new Uint16Array(current.length);r.readRenderTargetPixels(half,0,0,vp.width,vp.height,repeated);
    const hdr=draw(0);material.blending=T.NoBlending;
    // Ray/anchor output is data, so disable blending before data draws.
    const unblendedRay=draw(1),mass=draw(2),sourceAnchors=[draw(3,0),draw(3,1),draw(3,2),draw(3,3)];
    const batchRay=new Float32Array(current.length),batchMass=new Float32Array(current.length);
    r.readRenderTargetPixels(stage.frame,0,0,vp.width,vp.height,batchRay,undefined,0);
    // R32F attachment reads use RED/FLOAT in Three, one component per pixel.
    r.readRenderTargetPixels(stage.frame,0,0,vp.width,vp.height,batchMass,undefined,3);
    const gl=r.getContext(),saved=r.getRenderTarget();r.setRenderTarget(stage.frame);gl.readBuffer(gl.COLOR_ATTACHMENT2);
    const masks=new Map(wanted.map(pixel=>{const value=new Uint8Array(4);gl.readPixels(pixel%vp.width,Math.floor(pixel/vp.width),1,1,gl.RGBA,gl.UNSIGNED_BYTE,value);return [pixel,value[0]];}));
    r.setRenderTarget(saved);
    const details=wanted.map(pixel=>({pixel,mask:masks.get(pixel),ray:compare(unblendedRay.subarray(pixel*4,pixel*4+4),batchRay.subarray(pixel*4,pixel*4+4)),
      mass:{source:mass[pixel*4],batch:batchMass[pixel]},
      metadataAvailable:masks.get(pixel)!==0,
      anchors:masks.get(pixel)?compare(sourceAnchors.flatMap(data=>Array.from(data.subarray(pixel*4,pixel*4+4))),anchors.get(pixel)):null,
      sourceAnchors:sourceAnchors.flatMap(data=>Array.from(data.subarray(pixel*4,pixel*4+4))),batchAnchors:masks.get(pixel)?anchors.get(pixel):null}));
    const hdrVsReference=halfCompare(hdr,reference);
    return {scope:'Instrumented new program; requires its mode-zero HDR control to reproduce the unchanged reference before attributing internal differences.',
      attributionValid:hdrVsReference.changed===0,hdrVsReference,hdrVsBatch:halfCompare(hdr,current),batchRepeat:halfCompare(repeated,current),captures,details,shader};
  } finally {r.render=rawRender;material.dispose();target.dispose();half.dispose();scene.clear();}
}
