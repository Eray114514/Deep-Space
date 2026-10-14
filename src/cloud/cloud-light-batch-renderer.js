import * as THREE from 'three';
import {planCloudLightBatches} from './cloud-light-batch-layout.js';
import {cloudLightBatchShaders,cloudLightBatchVertex} from './cloud-light-batch-glsl.js';

const fullscreen=/* glsl */`
  varying vec3 vDirection,vViewDirection;
  void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}
`;

// Owns one synchronous command sequence and scratch pages, never prior-frame
// light data. Render never reads back, waits, or schedules asynchronous work;
// separate cancellable program preparation publishes no volume image.
export class CloudLightBatchRenderer {
  constructor(material,options) {
    this.disposed=false;
    this.submissions=0;
    this.targets=[];
    this.materials=[];
    this.page={uPageSize:{value:new THREE.Vector2()},uPageTilesX:{value:0},
      uPageMetaColumns:{value:0},uPageLightColumns:{value:0},
      uBatchStart:{value:0},uBatchCount:{value:0},uPageAtlasSize:{value:new THREE.Vector2()}};
    for(const name of ['tPageRay','tPageCached','tPageMask','tPageOpacity','tPageTileMask',
      'tPage0','tPage1','tPage2','tPage3','tPageLight'])this.page[name]={value:null};
    this.configure(material,options);
  }

  configure(material,options) {
    if(this.disposed)throw Error('Cloud batch executor disposed');
    if(material.defines.PRODUCTION_CLOUD_MEDIUM!==1||material.defines.CLOUD_FAR_VIEW
      ||material.uniforms.uLightQuadratureSteps.value!==16)throw Error('Cloud batches require production near 16-anchor transport');
    const plan=planCloudLightBatches(options);
    // One bounded program family, keyed by every source property used below.
    // Owner identity and texture sizes are uniform data, not shader variants.
    const signature=JSON.stringify(Object.keys(material.defines).sort().map(name=>[name,material.defines[name]]));
    if(this.fragment!==material.fragmentShader||this.vertex!==material.vertexShader||this.signature!==signature
      ||this.side!==material.side||this.premultipliedAlpha!==material.premultipliedAlpha) {
      this.cancelPreparation?.();
      this.releaseScratch();this.materials.forEach(shader=>shader.dispose());this.materials=[];
      this.fragment=material.fragmentShader;this.vertex=material.vertexShader;this.signature=signature;
      this.side=material.side;this.premultipliedAlpha=material.premultipliedAlpha;
      this.programEpoch=(this.programEpoch||0)+1;this.preparation=null;this.programsReady=false;this.preparationError=null;
    }
    const layoutKey=JSON.stringify([plan.width,plan.height,plan.beamBytes,plan.metadata,plan.light]);
    if(plan.direct||layoutKey!==this.layoutKey)this.releaseScratch();
    this.plan=plan;
    if(plan.direct)return;
    if(!this.materials.length)this.createPrograms(material);
    if(!this.targets.length)this.createTargets(plan);
    this.layoutKey=layoutKey;
    // Three retains this dictionary for uploads. Mutate it in place, removing
    // obsolete owners without replacing the renderer's cached dictionary.
    if(this.source!==material)for(const shader of this.materials) {
      for(const name of Object.keys(shader.uniforms))if(!(name in material.uniforms)&&!(name in this.page))delete shader.uniforms[name];
      Object.assign(shader.uniforms,material.uniforms,this.page);
    }
    this.source=material;
  }

  createTargets({width,height,tilesX,tilesY,metadata,light,beamBytes}) {
    const target=(w,h,extra={})=>{
      const rt=new THREE.WebGLRenderTarget(w,h,{type:THREE.FloatType,depthBuffer:false,
        minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,...extra});
      this.targets.push(rt);return rt;
    };
    this.frame=target(width,height,{count:4});
    this.frame.textures[1].type=THREE.HalfFloatType;
    this.frame.textures[2].type=THREE.UnsignedByteType;this.frame.textures[2].format=THREE.RedFormat;
    this.frame.textures[3].format=THREE.RedFormat;
    this.tileMask=target(tilesX,tilesY,{type:THREE.UnsignedByteType});
    this.metadata=target(metadata.width,metadata.height,{count:4});
    this.light=target(light.width,light.height,{format:THREE.RedFormat,type:beamBytes===2?THREE.HalfFloatType:THREE.FloatType});
    this.page.uPageSize.value.set(width,height);this.page.uPageTilesX.value=tilesX;
    this.page.uPageMetaColumns.value=metadata.columns;this.page.uPageLightColumns.value=light.columns;
    Object.entries({tPageRay:this.frame.textures[0],tPageCached:this.frame.textures[1],
      tPageMask:this.frame.textures[2],tPageOpacity:this.frame.textures[3],tPageTileMask:this.tileMask.texture,
      tPage0:this.metadata.textures[0],tPage1:this.metadata.textures[1],
      tPage2:this.metadata.textures[2],tPage3:this.metadata.textures[3],tPageLight:this.light.texture})
      .forEach(([name,texture])=>{this.page[name].value=texture;});
  }

  createPrograms(material) {
    const shaders=cloudLightBatchShaders(material.fragmentShader);
    const make=(name,mode=-1,mrt=false)=>{
      const m=new THREE.ShaderMaterial({uniforms:{...material.uniforms,...this.page},
        defines:{...material.defines,...(mode>=0?{PAGE_MODE:mode}:{})},
        vertexShader:name==='prepare'?material.vertexShader:mode>=0?cloudLightBatchVertex:fullscreen,
        fragmentShader:shaders[name],glslVersion:mrt?THREE.GLSL3:null,
        depthTest:false,depthWrite:false,blending:THREE.NoBlending,
        side:name==='prepare'?material.side:THREE.DoubleSide,premultipliedAlpha:material.premultipliedAlpha});
      m.name='cloud-batch-'+name;this.materials.push(m);return m;
    };
    this.prepare=make('prepare',-1,true);this.reduce=make('reduce');this.base=make('base');
    this.metadataMaterial=make('metadata',0,true);this.lightMaterial=make('beams',1);this.compose=make('compose',2);
    if(this.quadGeometry)return;
    this.quadGeometry=new THREE.PlaneGeometry(2,2);
    this.tileGeometry=new THREE.InstancedBufferGeometry();
    this.tileGeometry.setIndex(this.quadGeometry.index.clone());
    this.tileGeometry.setAttribute('position',this.quadGeometry.attributes.position.clone());
    this.scene=new THREE.Scene();this.mesh=new THREE.Mesh();this.mesh.matrixAutoUpdate=false;this.mesh.frustumCulled=false;
    this.mesh.layers.set(2);this.scene.add(this.mesh);
    this.quadScene=new THREE.Scene();this.quad=new THREE.Mesh(this.quadGeometry);this.quadScene.add(this.quad);
    this.tileScene=new THREE.Scene();this.tileMesh=new THREE.Mesh(this.tileGeometry);this.tileMesh.frustumCulled=false;this.tileScene.add(this.tileMesh);
    this.quadCamera=new THREE.Camera();
  }

  releaseScratch() {
    this.targets.forEach(target=>target.dispose());this.targets=[];
    this.frame=this.tileMask=this.metadata=this.light=null;this.layoutKey=null;this.source=null;
    for(const [name,uniform] of Object.entries(this.page))if(name.startsWith('tPage'))uniform.value=null;
    // Keep programs without retaining old planets, textures or borrowed meshes.
    for(const material of this.materials)for(const name of Object.keys(material.uniforms))
      if(!(name in this.page))delete material.uniforms[name];
    if(this.mesh)this.mesh.geometry=null;
  }

  prepareAsync(renderer,camera,sourceMesh,output) {
    if(this.disposed||this.plan.direct||!this.targets.length)return Promise.resolve(false);
    if(this.preparation)return this.preparation;
    const gl=renderer.getContext(),parallel=gl.getExtension('KHR_parallel_shader_compile');
    if(!parallel) {this.preparationError='Parallel shader compile unavailable';return Promise.resolve(false);}
    const epoch=this.programEpoch,compileCamera=camera.clone(),programs=[];
    compileCamera.layers.set(2);
    sourceMesh.updateWorldMatrix(true,false);this.mesh.geometry=sourceMesh.geometry;this.mesh.material=this.prepare;
    this.mesh.matrix.copy(sourceMesh.matrixWorld);this.scene.updateMatrixWorld(true);
    const saved=renderer.getRenderTarget(),face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
    try {
      // Capture the exact framebuffer/program variants synchronously. All
      // renderer state is restored before polling; no player state crosses await.
      for(const [target,material,kind] of [[this.frame,this.prepare,'mesh'],[this.tileMask,this.reduce,'quad'],
        [output,this.base,'quad'],[this.metadata,this.metadataMaterial,'tiles'],
        [this.light,this.lightMaterial,'tiles'],[output,this.compose,'tiles']]) {
        renderer.setRenderTarget(target);
        if(kind==='quad')this.quad.material=material;
        if(kind==='tiles')this.tileMesh.material=material;
        renderer.compile(kind==='mesh'?this.scene:kind==='tiles'?this.tileScene:this.quadScene,
          kind==='mesh'?compileCamera:this.quadCamera);
        programs.push(renderer.properties.get(material).currentProgram.program);
      }
    } catch(error) {this.preparationError=String(error);return Promise.resolve(false);}
    finally {renderer.setRenderTarget(saved,face,mip);}
    // Own the readiness poll so dispose/source revision can cancel it before
    // destroying programs. A renderer.compileAsync poll has no cancellation API.
    this.preparation=new Promise(resolve=>{
      let timer=null;const deadline=performance.now()+60000;
      const finish=ready=>{clearTimeout(timer);this.cancelPreparation=null;resolve(ready);};
      this.cancelPreparation=()=>finish(false);
      const check=()=>{
        if(this.disposed||this.programEpoch!==epoch)return finish(false);
        try {
          if(programs.every(program=>gl.getProgramParameter(program,parallel.COMPLETION_STATUS_KHR))) {
            if(!programs.every(program=>gl.getProgramParameter(program,gl.LINK_STATUS)))throw Error('Cloud program link failed');
            this.programsReady=true;return finish(true);
          }
          if(performance.now()>deadline)throw Error('Cloud program preparation deadline');
          timer=setTimeout(check,10);
        } catch(error) {this.preparationError=String(error);finish(false);}
      };
      check();
    });
    return this.preparation;
  }

  render(renderer,camera,sourceMesh,output) {
    if(this.disposed||this.plan.direct||!this.targets.length)return false;
    const {width,height,batchTiles,tileCount}=this.plan;
    if(output.width!==width||output.height!==height)throw Error('Cloud batch target size changed');
    if(sourceMesh.material!==this.source||this.source.uniforms.uLightQuadratureSteps.value!==16)
      throw Error('Cloud batch source owner changed');
    // Refresh uniform OWNER references too: the atmosphere pass may replace a
    // uniform object without changing the cloud material or texture identity.
    for(const material of this.materials) {
      Object.assign(material.uniforms,this.source.uniforms,this.page);
      material.uniformsNeedUpdate=true;
    }
    sourceMesh.updateWorldMatrix(true,false);
    this.mesh.geometry=sourceMesh.geometry;this.mesh.material=this.prepare;
    this.mesh.matrix.copy(sourceMesh.matrixWorld);this.scene.updateMatrixWorld(true);
    const saved=renderer.getRenderTarget(),face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
    const auto=renderer.autoClear,color=renderer.getClearColor(new THREE.Color()),alpha=renderer.getClearAlpha();
    const draw=(target,material,kind='quad',clear=true,count=0)=>{
      renderer.setRenderTarget(target);if(clear)renderer.clear(true,false,false);
      if(kind==='mesh')renderer.render(this.scene,camera);
      else if(kind==='tiles') {
        this.tileGeometry.instanceCount=count;this.tileMesh.material=material;
        this.page.uPageAtlasSize.value.set(target.width,target.height);
        renderer.render(this.tileScene,this.quadCamera);
      } else {this.quad.material=material;renderer.render(this.quadScene,this.quadCamera);}
    };
    try {
      renderer.autoClear=false;renderer.setClearColor(0,0);
      draw(this.frame,this.prepare,'mesh');draw(this.tileMask,this.reduce);
      draw(output,this.base);
      for(let start=0;start<tileCount;start+=batchTiles) {
        const count=Math.min(batchTiles,tileCount-start);
        this.page.uBatchStart.value=start;this.page.uBatchCount.value=count;
        draw(this.metadata,this.metadataMaterial,'tiles',true,count);
        draw(this.light,this.lightMaterial,'tiles',true,count*4);
        draw(output,this.compose,'tiles',false,count);
      }
      this.submissions++;
      return true;
    } finally {
      renderer.autoClear=auto;renderer.setClearColor(color,alpha);renderer.setRenderTarget(saved,face,mip);
    }
  }

  dispose() {
    if(this.disposed)return;
    this.cancelPreparation?.();
    this.disposed=true;
    this.releaseScratch();this.materials.forEach(material=>material.dispose());this.materials=[];
    this.quadGeometry?.dispose();this.tileGeometry?.dispose();
    // sourceMesh geometry/material and all physical textures belong elsewhere.
    if(this.mesh)this.mesh.geometry=null;
  }
}
