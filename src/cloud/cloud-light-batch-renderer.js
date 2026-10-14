import * as THREE from 'three';
import {planCloudLightBatches} from './cloud-light-batch-layout.js';
import {cloudLightBatchShaders,cloudLightBatchVertex} from './cloud-light-batch-glsl.js';

const fullscreen=/* glsl */`
  varying vec3 vDirection,vViewDirection;
  void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}
`;

// Owns one synchronous command sequence and scratch pages, never prior-frame
// light data. No readback, timer wait, finish, worker, or asynchronous callback.
export class CloudLightBatchRenderer {
  constructor(material,options) {
    this.source=material;
    this.plan=planCloudLightBatches(options);
    this.disposed=false;
    this.submissions=0;
    this.targets=[];
    this.materials=[];
    if(this.plan.direct)return;
    if(material.defines.PRODUCTION_CLOUD_MEDIUM!==1||material.defines.CLOUD_FAR_VIEW
      ||material.uniforms.uLightQuadratureSteps.value!==16)throw Error('Cloud batches require production near 16-anchor transport');
    const {width,height,tilesX,tilesY,metadata,light,beamBytes}=this.plan;
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
    this.page={uPageSize:{value:new THREE.Vector2(width,height)},uPageTilesX:{value:tilesX},
      uPageMetaColumns:{value:metadata.columns},uPageLightColumns:{value:light.columns},
      uBatchStart:{value:0},uBatchCount:{value:0},uPageAtlasSize:{value:new THREE.Vector2()},
      tPageRay:{value:this.frame.textures[0]},tPageCached:{value:this.frame.textures[1]},
      tPageMask:{value:this.frame.textures[2]},tPageOpacity:{value:this.frame.textures[3]},tPageTileMask:{value:this.tileMask.texture},
      tPage0:{value:this.metadata.textures[0]},tPage1:{value:this.metadata.textures[1]},
      tPage2:{value:this.metadata.textures[2]},tPage3:{value:this.metadata.textures[3]},tPageLight:{value:this.light.texture}};
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

  render(renderer,camera,sourceMesh,output) {
    if(this.disposed||this.plan.direct)return false;
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
    this.disposed=true;
    this.targets.forEach(target=>target.dispose());this.materials.forEach(material=>material.dispose());
    this.quadGeometry?.dispose();this.tileGeometry?.dispose();
    // sourceMesh geometry/material and all physical textures belong elsewhere.
    if(this.mesh)this.mesh.geometry=null;
  }
}
