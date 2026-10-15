import {mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';
const quantiles=process.argv.includes('--quantiles');
if(process.argv.slice(2).some(arg=>arg!=='--quantiles'))throw Error('Supported option: --quantiles');
const out='test-results/cloud-light-batch/'+(quantiles?'scene-quantiles':'scene-diagnostic'),before=await evidenceFingerprint('tools/cloudlightbatchscenediag.js');
const dependencies=['tools/cloud-light-draw-diagnostic.js','tools/cloud-light-quantile-diagnostic.js'];
const helperBefore=await Promise.all(dependencies.map(file=>evidenceFingerprint(file)));
await mkdir(out,{recursive:true});const {server,port}=await startServer(0);let browser;const errors=[];
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  const page=await browser.newPage({viewport:{width:1280,height:720}});
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&freeze=1&time=9.5&scene=lowflight&alt=400&planet=0&bias=meadow&quality=balanced&vclouds=1&post=1`);
  await page.waitForFunction(()=>NMS?.booted&&NMS._planet(0).volCloudMat.uniforms.uSunCacheReady.value===1,null,{timeout:180000});
  await page.evaluate(async({quantiles})=>{
    const {inspectCloudDraw,inspectCloudTextureContents,reuploadCloudUniforms}=await import('/tools/cloud-light-draw-diagnostic.js');
    const {inspectCloudQuantiles}=await import('/tools/cloud-light-quantile-diagnostic.js');
    NMS.setAdaptiveQualityLocked(true);const T=NMS._THREE,r=NMS._renderer,vp=NMS._pipeline.volumePass,p=NMS._planet(0);
    const state=window._sceneDiag={records:[],writes:[],draws:[]},rawBatch=vp.renderLightBatches,rawRender=vp.render,rawSetTarget=r.setRenderTarget;
    const gl=r.getContext(),rawDraw=gl.drawElements;
    gl.drawElements=function(...args){
      if(state.recording&&state.phase==='scene-gl-upload')state.uniformUploads=reuploadCloudUniforms(gl);
      if(state.recording&&['batch','scene','scene-repeat','private-no-blend'].includes(state.phase)) {
        const source=state.phase==='batch'?vp.lightBatch?.prepare:state.drawMaterial||p.volCloudMat;
        if(gl.getParameter(gl.CURRENT_PROGRAM)===r.properties.get(source)?.currentProgram?.program)
          state.draws.push({phase:state.phase,args,...inspectCloudDraw(gl),textures:inspectCloudTextureContents(r,source)});
      }
      return rawDraw.apply(this,args);
    };
    const textures=()=>new Map(Object.entries(p.volCloudMat.uniforms).filter(([,u])=>u.value?.isTexture).map(([key,u])=>[u.value,key]));
    const snapshot=()=>({camera:vp.camera.matrixWorld.elements.slice(),inverse:vp.camera.matrixWorldInverse.elements.slice(),
      projection:vp.camera.projectionMatrix.elements.slice(),mesh:p.volCloudMesh.matrixWorld.elements.slice(),
      uniforms:Object.fromEntries(Object.entries(p.volCloudMat.uniforms).map(([key,{value}])=>[key,
        value?.isTexture?{uuid:value.uuid,version:value.version,sourceVersion:value.source.version}:JSON.parse(JSON.stringify(value))]))});
    const uploadRestores=[];
    for(const name of ['texImage2D','texImage3D','texSubImage2D','texSubImage3D','texStorage2D','texStorage3D','copyTexSubImage2D','copyTexSubImage3D','generateMipmap']) {
      const raw=gl[name];gl[name]=function(...args){
        if(state.recording) {
          const binding=args[0]===gl.TEXTURE_3D?gl.TEXTURE_BINDING_3D:args[0]===gl.TEXTURE_2D_ARRAY?gl.TEXTURE_BINDING_2D_ARRAY:gl.TEXTURE_BINDING_2D;
          const handle=gl.getParameter(binding);
          for(const [texture,owner] of textures())if(r.properties.get(texture).__webglTexture===handle)state.writes.push({kind:'texture-update',phase:state.phase,name,owner});
        }
        return raw.apply(this,args);
      };uploadRestores.push(()=>{gl[name]=raw;});
    }
    r.setRenderTarget=function(target,...args){if(state.recording&&target)for(const tex of [...target.textures,target.depthTexture]){
      const name=textures().get(tex);if(name)state.writes.push({kind:'target-binding',phase:state.phase,name});
    }return rawSetTarget.call(this,target,...args);};
    vp.renderLightBatches=function(...args){state.before=snapshot();state.phase='batch';return rawBatch.apply(this,args);};
    vp.setLightBatchesEnabled(true,{budgetBytes:8*1024*1024});
    vp.render=function(...args){
      if(state.records.length)return rawRender.apply(this,args);
      // Keep only the selected submitted frame; preparation fallback frames
      // may restore the composer depth target but are a different epoch.
      state.writes=[];state.draws=[];
      p.volCloudMat.uniforms.uFrame.value=192;state.recording=true;const result=rawRender.apply(this,args);
      if(!vp.lightBatchStatus.submitted){state.recording=false;return result;}
      const before=state.before,after=snapshot(),geometry=p.volCloudMesh.geometry,camera=this.camera;
      const width=this.width,height=this.height,target=new T.WebGLRenderTarget(width,height,{type:T.HalfFloatType,depthBuffer:false});
      const current=new Uint16Array(width*height*4);r.readRenderTargetPixels(this.current,0,0,width,height,current);
      const saved=r.getRenderTarget(),face=r.getActiveCubeFace(),mip=r.getActiveMipmapLevel(),auto=r.autoClear;
      const mask=camera.layers.mask,color=r.getClearColor(new T.Color()),alpha=r.getClearAlpha();
      const privateScene=new T.Scene(),mesh=new T.Mesh(geometry,p.volCloudMat);mesh.layers.set(2);mesh.frustumCulled=false;
      mesh.matrixAutoUpdate=false;mesh.matrix.copy(p.volCloudMesh.matrixWorld);privateScene.add(mesh);privateScene.updateMatrixWorld(true);
      // Material.clone clones Texture views and bumps their shared Source
      // versions. Borrow uniforms explicitly so the diagnostic never does so.
      const owner=p.volCloudMat,clone=new T.ShaderMaterial({uniforms:{...owner.uniforms},defines:{...owner.defines},
        vertexShader:owner.vertexShader,fragmentShader:owner.fragmentShader,glslVersion:owner.glslVersion,
        side:owner.side,depthTest:owner.depthTest,depthWrite:owner.depthWrite,transparent:owner.transparent,
        premultipliedAlpha:owner.premultipliedAlpha,blending:T.NoBlending});
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
          ['scene-force-upload',this.scene,p.volCloudMat,undefined,true],['scene-gl-upload',this.scene,p.volCloudMat],
          ['private-same-material',privateScene,p.volCloudMat],
          ['private-no-blend',privateScene,clone],['private-toggle-no-blend',privateScene,p.volCloudMat,T.NoBlending],
          ['private-clone-blend',privateScene,clone,T.NormalBlending],['scene-repeat',this.scene,p.volCloudMat]]) {
          const oldBlend=material.blending;if(blend!==undefined)material.blending=blend;
          if(name==='scene-reset-state')r.resetState();
          if(force)material.uniformsNeedUpdate=true;
          state.phase=name;state.drawMaterial=material;mesh.material=material;r.setRenderTarget(target);r.clear(true,false,false);r.render(scene,camera);
          const pixels=new Uint16Array(current.length);r.readRenderTargetPixels(target,0,0,width,height,pixels);outputs.push(pixels);
          const program=r.properties.get(material).currentProgram;
          records.push({name,vsBatch:compare(current,pixels),program:program?.id,cacheKey:program?.cacheKey,
            shaders:r.getContext().getAttachedShaders(program.program).map(shader=>r.getContext().getShaderSource(shader)),gpu:gpuInputs(program.program)});
          if(quantiles&&name==='scene-gl-upload') {
            state.phase='quantile-probe';state.quantiles=inspectCloudQuantiles(this,current,outputs[0]);
          }
          material.blending=oldBlend;
        }
        state.phase='batch-repeat';this.lightBatch.render(r,camera,p.volCloudMesh,target);
        const repeated=new Uint16Array(current.length);r.readRenderTargetPixels(target,0,0,width,height,repeated);
        records.push({name:'batch-repeat',vsBatch:compare(current,repeated)});
        state.records.push({before,after,afterReference:snapshot(),inputChanges:Object.keys(before).filter(key=>JSON.stringify(before[key])!==JSON.stringify(after[key])),
          shaderUniformDictionarySame:r.properties.get(this.lightBatch.prepare).uniforms===this.lightBatch.prepare.uniforms,
          records,sceneVsPrivate:compare(outputs[0],outputs[1]),blendDifference:compare(outputs[1],outputs[2]),gl:r.getContext().getError()});
      }finally{
        state.recording=false;delete state.drawMaterial;camera.layers.mask=mask;r.autoClear=auto;r.setClearColor(color,alpha);r.setRenderTarget(saved,face,mip);
        clone.dispose();target.dispose();privateScene.clear();gl.drawElements=rawDraw;uploadRestores.forEach(restore=>restore());r.setRenderTarget=rawSetTarget;vp.renderLightBatches=rawBatch;vp.render=rawRender;
      }
      return result;
    };
  },{quantiles});
  await page.waitForFunction(()=>window._sceneDiag.records.length>0,null,{timeout:180000});
  const result=await page.evaluate(()=>window._sceneDiag);await page.screenshot({path:`${out}/player.png`});
  const after=await evidenceFingerprint('tools/cloudlightbatchscenediag.js'),helperAfter=await Promise.all(dependencies.map(file=>evidenceFingerprint(file)));
  await writeFile(`${out}/report.json`,JSON.stringify({before,after,dependencies,helperBefore,helperAfter,result,errors},null,2));
  assert.equal(before.sourceDigest,after.sourceDigest);assert.equal(before.verifierDigest,after.verifierDigest);
  for(let i=0;i<helperBefore.length;i++)assert.equal(helperBefore[i].verifierDigest,helperAfter[i].verifierDigest);
  assert.deepEqual(errors,[]);assert.equal(result.records[0].gl,0);
  console.log(JSON.stringify({records:result.records[0].records.map(({name,vsBatch,program})=>({name,vsBatch,program})),
    inputChanges:result.records[0].inputChanges,draws:result.draws,writes:result.writes,errors},null,2));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
