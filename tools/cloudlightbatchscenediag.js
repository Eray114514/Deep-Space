import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';
const out='test-results/cloud-light-batch/scene-diagnostic',before=await evidenceFingerprint('tools/cloudlightbatchscenediag.js');
await mkdir(out,{recursive:true});const {server,port}=await startServer(0);let browser;const errors=[];
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  const page=await browser.newPage({viewport:{width:1280,height:720}});
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&freeze=1&time=9.5&scene=lowflight&alt=400&planet=0&bias=meadow&quality=balanced&vclouds=1&post=1`);
  await page.waitForFunction(()=>NMS?.booted&&NMS._planet(0).volCloudMat.uniforms.uSunCacheReady.value===1,null,{timeout:180000});
  await page.evaluate(()=>{
    NMS.setAdaptiveQualityLocked(true);const T=NMS._THREE,r=NMS._renderer,vp=NMS._pipeline.volumePass,p=NMS._planet(0);
    const state=window._sceneDiag={records:[],writes:[]},rawBatch=vp.renderLightBatches,rawRender=vp.render,rawSetTarget=r.setRenderTarget;
    const textures=()=>new Map(Object.entries(p.volCloudMat.uniforms).filter(([,u])=>u.value?.isTexture).map(([key,u])=>[u.value,key]));
    const snapshot=()=>({camera:vp.camera.matrixWorld.elements.slice(),inverse:vp.camera.matrixWorldInverse.elements.slice(),
      projection:vp.camera.projectionMatrix.elements.slice(),mesh:p.volCloudMesh.matrixWorld.elements.slice(),
      uniforms:Object.fromEntries(Object.entries(p.volCloudMat.uniforms).map(([key,{value}])=>[key,
        value?.isTexture?{uuid:value.uuid,version:value.version,sourceVersion:value.source.version}:JSON.parse(JSON.stringify(value))]))});
    r.setRenderTarget=function(target,...args){if(state.recording&&target)for(const tex of target.textures){
      const name=textures().get(tex);if(name)state.writes.push({phase:state.phase,name});
    }return rawSetTarget.call(this,target,...args);};
    vp.renderLightBatches=function(...args){state.before=snapshot();state.phase='batch';return rawBatch.apply(this,args);};
    vp.setLightBatchesEnabled(true,{budgetBytes:8*1024*1024});
    vp.render=function(...args){
      if(state.records.length)return rawRender.apply(this,args);
      p.volCloudMat.uniforms.uFrame.value=192;state.recording=true;const result=rawRender.apply(this,args);
      if(!vp.lightBatchStatus.submitted){state.recording=false;return result;}
      const before=state.before,after=snapshot(),geometry=p.volCloudMesh.geometry,camera=this.camera;
      const width=this.width,height=this.height,target=new T.WebGLRenderTarget(width,height,{type:T.HalfFloatType,depthBuffer:false});
      const current=new Uint16Array(width*height*4);r.readRenderTargetPixels(this.current,0,0,width,height,current);
      const saved=r.getRenderTarget(),face=r.getActiveCubeFace(),mip=r.getActiveMipmapLevel(),auto=r.autoClear;
      const mask=camera.layers.mask,color=r.getClearColor(new T.Color()),alpha=r.getClearAlpha();
      const privateScene=new T.Scene(),mesh=new T.Mesh(geometry,p.volCloudMat);mesh.layers.set(2);mesh.frustumCulled=false;
      mesh.matrixAutoUpdate=false;mesh.matrix.copy(p.volCloudMesh.matrixWorld);privateScene.add(mesh);privateScene.updateMatrixWorld(true);
      const clone=p.volCloudMat.clone();clone.uniforms={...p.volCloudMat.uniforms};clone.blending=T.NoBlending;
      const records=[],outputs=[];
      const gpuInputs=program=>{
        const gl=r.getContext(),values={},bindings={},saved=gl.getParameter(gl.ACTIVE_TEXTURE);
        const names=new Map();for(const [texture,name] of textures())names.set(r.properties.get(texture).__webglTexture,name);
        for(let i=0;i<gl.getProgramParameter(program,gl.ACTIVE_UNIFORMS);i++) {
          const info=gl.getActiveUniform(program,i),name=info.name;
          const value=gl.getUniform(program,gl.getUniformLocation(program,name));
          values[name]=ArrayBuffer.isView(value)?Array.from(value):value;
          if(info.size>1&&name.endsWith('[0]'))for(let j=1;j<info.size;j++) {
            const element=name.slice(0,-3)+`[${j}]`,v=gl.getUniform(program,gl.getUniformLocation(program,element));
            values[element]=ArrayBuffer.isView(v)?Array.from(v):v;
          }
          if([gl.SAMPLER_2D,gl.SAMPLER_3D,gl.SAMPLER_2D_ARRAY,gl.UNSIGNED_INT_SAMPLER_2D,gl.INT_SAMPLER_2D].includes(info.type)) {
            gl.activeTexture(gl.TEXTURE0+value);
            const binding=gl.getParameter(info.type===gl.SAMPLER_3D?gl.TEXTURE_BINDING_3D:info.type===gl.SAMPLER_2D_ARRAY?gl.TEXTURE_BINDING_2D_ARRAY:gl.TEXTURE_BINDING_2D);
            const target=info.type===gl.SAMPLER_3D?gl.TEXTURE_3D:info.type===gl.SAMPLER_2D_ARRAY?gl.TEXTURE_2D_ARRAY:gl.TEXTURE_2D;
            bindings[name]={unit:value,owner:names.get(binding)||'unmapped',
              min:gl.getTexParameter(target,gl.TEXTURE_MIN_FILTER),mag:gl.getTexParameter(target,gl.TEXTURE_MAG_FILTER),
              base:gl.getTexParameter(target,gl.TEXTURE_BASE_LEVEL),max:gl.getTexParameter(target,gl.TEXTURE_MAX_LEVEL)};
          }
        }
        gl.activeTexture(saved);return {values,bindings};
      };
      const compare=(a,b)=>{let max=0,changed=0;const samples=[];for(let i=0;i<a.length;i++)if(a[i]!==b[i]){
        changed++;const av=T.DataUtils.fromHalfFloat(a[i]),bv=T.DataUtils.fromHalfFloat(b[i]);max=Math.max(max,Math.abs(av-bv));
        if(samples.length<10)samples.push({pixel:Math.floor(i/4),channel:i%4,a:av,b:bv});
      }return {changed,maximumError:max,samples};};
      try {
        camera.layers.set(2);r.autoClear=false;r.setClearColor(0,0);
        for(const [name,scene,material,blend,force] of [['scene',this.scene,p.volCloudMat],['scene-reset-state',this.scene,p.volCloudMat],
          ['scene-force-upload',this.scene,p.volCloudMat,undefined,true],
          ['private-same-material',privateScene,p.volCloudMat],
          ['private-no-blend',privateScene,clone],['private-toggle-no-blend',privateScene,p.volCloudMat,T.NoBlending],
          ['private-clone-blend',privateScene,clone,T.NormalBlending],['scene-repeat',this.scene,p.volCloudMat]]) {
          const oldBlend=material.blending;if(blend!==undefined)material.blending=blend;
          if(name==='scene-reset-state')r.resetState();
          if(force)material.uniformsNeedUpdate=true;
          state.phase=name;mesh.material=material;r.setRenderTarget(target);r.clear(true,false,false);r.render(scene,camera);
          const pixels=new Uint16Array(current.length);r.readRenderTargetPixels(target,0,0,width,height,pixels);outputs.push(pixels);
          const program=r.properties.get(material).currentProgram;
          records.push({name,vsBatch:compare(current,pixels),program:program?.id,cacheKey:program?.cacheKey,
            shaders:r.getContext().getAttachedShaders(program.program).map(shader=>r.getContext().getShaderSource(shader)),gpu:gpuInputs(program.program)});
          material.blending=oldBlend;
        }
        state.phase='batch-repeat';this.lightBatch.render(r,camera,p.volCloudMesh,target);
        const repeated=new Uint16Array(current.length);r.readRenderTargetPixels(target,0,0,width,height,repeated);
        records.push({name:'batch-repeat',vsBatch:compare(current,repeated)});
        state.records.push({before,after,afterReference:snapshot(),inputChanges:Object.keys(before).filter(key=>JSON.stringify(before[key])!==JSON.stringify(after[key])),
          shaderUniformDictionarySame:r.properties.get(this.lightBatch.prepare).uniforms===this.lightBatch.prepare.uniforms,
          records,sceneVsPrivate:compare(outputs[0],outputs[1]),blendDifference:compare(outputs[1],outputs[2]),gl:r.getContext().getError()});
      }finally{
        state.recording=false;camera.layers.mask=mask;r.autoClear=auto;r.setClearColor(color,alpha);r.setRenderTarget(saved,face,mip);
        clone.dispose();target.dispose();privateScene.clear();r.setRenderTarget=rawSetTarget;vp.renderLightBatches=rawBatch;vp.render=rawRender;
      }
      return result;
    };
  });
  await page.waitForFunction(()=>window._sceneDiag.records.length>0,null,{timeout:180000});
  const result=await page.evaluate(()=>window._sceneDiag);await page.screenshot({path:`${out}/player.png`});
  const after=await evidenceFingerprint('tools/cloudlightbatchscenediag.js');await writeFile(`${out}/report.json`,JSON.stringify({before,after,result,errors},null,2));
  console.log(JSON.stringify({records:result.records[0].records,inputChanges:result.records[0].inputChanges,sceneVsPrivate:result.records[0].sceneVsPrivate,
    blendDifference:result.records[0].blendDifference,writes:result.writes,errors},null,2));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
