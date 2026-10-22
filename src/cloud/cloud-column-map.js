import * as THREE from 'three';
import { OwnedScreenTriangle as FullScreenQuad } from '../owned-screen-triangle.js';
import { createCloudColumnMaterial } from './cloud-column-material.js';

// Opacity, not averaged noise, is filtered for unresolved cloud cells. Columns
// are baked from the production density kernel; no independent cloud layout.
export class CloudColumnMap {
  constructor(planet, { width=1024, samples=128, footprintSamples=64, hours=planet.weatherHours, programOwner=null }={}) {
    this.planet=planet; this.width=width; this.height=width/2;
    this.samples=samples; this.footprintSamples=footprintSamples;
    this.row=0; this.ready=false; this.disposed=false;
    this.programOwner=programOwner;
    this.target=new THREE.WebGLRenderTarget(width,this.height,{depthBuffer:false,count:2,
      type:THREE.UnsignedByteType,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter});
    this.target.textures[1].type=THREE.HalfFloatType;
    this.target.textures[1].format=THREE.RGBAFormat;
    for(const texture of this.target.textures){texture.wrapS=THREE.RepeatWrapping;texture.colorSpace=THREE.NoColorSpace;}
    Object.assign(this,createCloudColumnMaterial(planet,{width,samples,footprintSamples,hours}));
    this.quad=new FullScreenQuad(this.material);
    this.generation=hours; this.uploadMs=[];
  }
  bakeSlice(renderer,rows=1) {
    if(this.ready || this.disposed) return;
    const savedTarget=renderer.getRenderTarget(),autoClear=renderer.autoClear;
    const face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
    const started=performance.now();
    try {
      // RenderTarget regions are physical texels. Renderer.setScissor and
      // setViewport take logical pixels and multiply by DPR, even offscreen.
      this.target.viewport.set(0,0,this.width,this.height);
      this.target.scissor.set(0,this.row,this.width,Math.min(rows,this.height-this.row));
      this.target.scissorTest=true;renderer.setRenderTarget(this.target);
      renderer.autoClear=false; this.quad.render(renderer);
      this.row+=rows;
      if(this.row>=this.height) {
        this.ready=true;
        for(const texture of this.snapshots)texture.dispose();this.snapshots=[];
        // Shader uniforms also retain the CPU snapshot image arrays. A ready
        // column only needs its finished targets, not the baking material.
        this.releaseProgram();this.quad.dispose();
        this.material=null;this.quad=null;
      }
    } finally {
      renderer.setRenderTarget(savedTarget,face,mip);renderer.autoClear=autoClear;
    }
    this.uploadMs.push(performance.now()-started);
  }
  releaseProgram() {
    if(!this.material)return;
    // Three also retains this dictionary in renderer properties. Empty the
    // same object so the compiled program lease does not pin CPU snapshots.
    for(const name of Object.keys(this.material.uniforms))delete this.material.uniforms[name];
    if(this.programOwner && !this.programOwner.retired && !this.programOwner.columns)this.programOwner.columns=this.material;
    else this.material.dispose();
  }
  dispose() { if(this.disposed) return;this.disposed=true;this.target.dispose();this.releaseProgram();this.quad?.dispose();
    this.material=null;this.quad=null;
    for(const texture of this.snapshots)texture.dispose();this.snapshots=[]; }
}
