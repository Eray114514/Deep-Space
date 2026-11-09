// Use the original near material and full viewport. Only scissor boundaries
// change, on even rows so 2x2 fragment derivative quads stay in one band.
export function installNearVolumeTiles(game,{bands=8,verify=false}={}) {
  const { _pipeline:pipeline,_renderer:renderer,_THREE:T }=game;
  const pass=pipeline.volumePass, profile=pass.profilePhase;
  const stats={frames:0,draws:0,maxBands:0,parity:null};
  const gl=renderer.getContext();
  function hook(name,work,options) {
    if(name!=='volume-current')return profile.call(this,name,work,options);
    const render=renderer.render;
    renderer.render=function(scene,camera) {
      const planet=pass.activePlanet,mesh=planet?.volCloudMesh,target=pass.current;
      if(!mesh || mesh.material!==planet.volCloudMat || scene!==pass.scene || camera!==pass.camera
        || renderer.getRenderTarget()!==target || target.scissorTest
        || !pass.farSplit.soleOwner(scene,mesh)) return render.call(this,scene,camera);
      const original=target.scissor.clone(),auto=renderer.autoClear;
      const face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
      const stride=Math.ceil(target.height/(bands*2))*2;
      let submitted=0;
      try {
        renderer.autoClear=false;target.scissorTest=true;
        for(let y=0;y<target.height;y+=stride) {
          target.scissor.set(0,y,target.width,Math.min(stride,target.height-y));
          renderer.setRenderTarget(target,face,mip);
          render.call(this,scene,camera);
          submitted++;
          if(gl.isContextLost())throw Error('Near volume context lost while drawing bands');
        }
      } finally {
        target.scissor.copy(original);target.scissorTest=false;
        renderer.autoClear=auto;renderer.setRenderTarget(target,face,mip);
      }
      stats.frames++;stats.draws+=submitted;stats.maxBands=Math.max(stats.maxBands,submitted);
      if(verify && !stats.parity) {
        const scratch=new T.WebGLRenderTarget(target.width,target.height,{type:T.HalfFloatType,depthBuffer:false});
        const pixels=new Uint16Array(target.width*target.height*4),reference=new Uint16Array(pixels.length);
        try {
          renderer.readRenderTargetPixels(target,0,0,target.width,target.height,pixels);
          renderer.setRenderTarget(scratch);renderer.autoClear=false;
          renderer.clear(true,false,false);render.call(this,scene,camera);
          renderer.readRenderTargetPixels(scratch,0,0,target.width,target.height,reference);
          let changed=0,nonempty=0;
          for(let i=0;i<pixels.length;i++) {
            if(pixels[i]!==reference[i])changed++;
            if(i%4===3 && T.DataUtils.fromHalfFloat(reference[i])>0)nonempty++;
          }
          stats.parity={width:target.width,height:target.height,changed,nonempty};
          if(changed || !nonempty)throw Error('Near volume bands differ from the single native draw');
        } finally {
          renderer.autoClear=auto;renderer.setRenderTarget(target,face,mip);scratch.dispose();
        }
      }
    };
    try { return profile.call(this,name,work,options); }
    finally { renderer.render=render; }
  }
  pass.profilePhase=hook;
  return stats;
}
