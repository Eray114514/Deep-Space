import * as THREE from 'three';
import { OwnedScreenTriangle } from '../owned-screen-triangle.js';
import { createCloudColumnMaterial } from './cloud-column-material.js';
import { weatherSourcesCurrent } from './weather-sources.js';

// One resumable tile owns both pingpong targets until its canonical write.
// Same-context command order permits reuse after submission; no fence waits.
export class CloudColumnScratch {
  constructor(width=1024,rows=2) {
    if(!Number.isInteger(width)||width<2||!Number.isInteger(rows)||rows<1)throw Error('Invalid column scratch dimensions');
    this.width=width;this.rows=rows;this.bytes=2*width*rows*9*4;
    this.owner=null;this.token=0;this.epoch=0;this.lost=false;this.disposed=false;
    this.renderer=null;this.initializedEpoch=-1;this.drawing=null;this.released=false;
    this.retiring=[];this.targets=this.createTargets();
    this.onLost=()=>{
      this.lost=true;this.epoch++;const owner=this.owner;this.owner=null;
      owner?.map.invalidate('context-lost');
      // Old renderer disposal listeners carry old-context GL handles. Retire
      // them while lost; never reinitialize the same target in a new epoch.
      this.retiring.push(...this.targets);this.targets=this.createTargets();
      if(!this.drawing)this.releaseRetiredTargets();
    };
    this.onRestored=()=>{this.lost=false;};
  }
  createTargets() {
    return Array.from({length:2},()=>{
      const target=new THREE.WebGLRenderTarget(this.width,this.rows,{depthBuffer:false,count:3,
        type:THREE.FloatType,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter});
      // The joint-opacity carry reads only .r; retain all nine float values
      // and the original GLSL while avoiding three unused storage channels.
      target.textures[2].format=THREE.RedFormat;
      for(const texture of target.textures){texture.colorSpace=THREE.NoColorSpace;texture.generateMipmaps=false;}
      return target;
    });
  }
  releaseRetiredTargets() {
    for(const target of this.retiring)target.dispose();this.retiring=[];
  }
  observeRenderer(renderer) {
    if(this.disposed)throw Error('Disposed column scratch');
    if(this.renderer&&this.renderer!==renderer)throw Error('Column scratch cannot cross renderers');
    if(!this.renderer) {
      this.renderer=renderer;
      renderer.domElement.addEventListener('webglcontextlost',this.onLost);
      renderer.domElement.addEventListener('webglcontextrestored',this.onRestored);
    }
  }
  prepare(renderer) {
    this.observeRenderer(renderer);
    const gl=renderer.getContext();
    if(this.lost||gl.isContextLost())throw Error('Column scratch context is lost');
    if(this.initializedEpoch!==this.epoch) {
      if(gl.getParameter(gl.MAX_DRAW_BUFFERS)<3||!gl.getExtension('EXT_color_buffer_float'))throw Error('Column scratch requires float MRT');
      // Initialize both read attachments too, including on the first p=0 draw.
      for(const target of this.targets)renderer.initRenderTarget(target);
      this.initializedEpoch=this.epoch;
    }
  }
  acquire(map,renderer) {
    if(this.drawing)return null;
    if(this.owner&&this.owner.map!==map)return null;
    this.prepare(renderer);
    if(!this.owner)this.owner={map,row:map.row,generation:map.generation,epoch:this.epoch,token:++this.token};
    const lease=this.owner;
    if(lease.row!==map.row||lease.generation!==map.generation||lease.epoch!==this.epoch)throw Error('Invalid column scratch lease');
    return lease.token;
  }
  release(map,token) {
    if(this.owner?.map===map&&this.owner.token===token)this.owner=null;
  }
  beginDraw(map) {
    if(this.drawing||this.owner?.map!==map)throw Error('Column scratch draw has no exclusive lease');
    this.drawing=map;
  }
  endDraw(map) {
    if(this.drawing!==map)throw Error('Column scratch draw owner changed');
    this.drawing=null;this.releaseRetiredTargets();if(this.disposed)this.releaseTargets();
  }
  releaseTargets() {
    if(this.released)return;this.released=true;
    this.releaseRetiredTargets();for(const target of this.targets)target.dispose();this.renderer=null;
  }
  dispose() {
    if(this.disposed)return;this.disposed=true;
    const owner=this.owner;this.owner=null;owner?.map.invalidate('scratch-disposed');
    if(this.renderer) {
      this.renderer.domElement.removeEventListener('webglcontextlost',this.onLost);
      this.renderer.domElement.removeEventListener('webglcontextrestored',this.onRestored);
    }
    if(!this.drawing)this.releaseTargets();
  }
}

// Explicit work-count producer. row counts only canonical rows whose final
// draw returned. ready means ordered submission, never GPU completion time.
// The ordinary CloudColumnMap remains the default bank producer.
export class CloudColumnTileMap {
  constructor(planet,{width=1024,samples=128,footprintSamples=64,hours=planet.weatherHours,
    tileRows=2,footprintBatch=8,scratch=null,programOwner=null}={}) {
    if(!Number.isInteger(width)||width<2||width%2||!Number.isInteger(tileRows)||tileRows<1
      ||!Number.isInteger(samples)||samples<1||!Number.isInteger(footprintSamples)||footprintSamples<1
      ||!Number.isInteger(footprintBatch)||footprintBatch<1)throw Error('Invalid column work dimensions');
    if(scratch&&(scratch.width!==width||scratch.rows<tileRows||scratch.disposed))throw Error('Incompatible column scratch');
    this.planet=planet;this.width=width;this.height=width/2;this.samples=samples;
    this.footprintSamples=footprintSamples;this.generation=hours;this.tileRows=tileRows;this.footprintBatch=footprintBatch;
    this.row=0;this.footprintCursor=0;this.scratchIndex=-1;this.lease=null;
    this.ready=false;this.disposed=false;this.invalidated=false;this.reason=null;
    this.startedWork=false;this.startedFinal=false;
    this.inWork=false;
    this.renderer=null;this.contextEpoch=null;this.programOwner=programOwner;this.uploadMs=[];
    this.fieldOwner=planet.weatherField;this.speciesMask=planet.volCloudMat.uniforms.uSpeciesMask.value;
    this.scratch=scratch||new CloudColumnScratch(width,tileRows);this.ownsScratch=!scratch;
    this.target=new THREE.WebGLRenderTarget(width,this.height,{depthBuffer:false,count:2,
      type:THREE.UnsignedByteType,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter});
    this.target.textures[1].type=THREE.HalfFloatType;this.target.textures[1].format=THREE.RGBAFormat;
    for(const texture of this.target.textures){texture.wrapS=THREE.RepeatWrapping;texture.colorSpace=THREE.NoColorSpace;}
    Object.assign(this,createCloudColumnMaterial(planet,{width,samples,footprintSamples,hours,tiled:true}));
    this.material.defines.COLUMN_TILE_FINAL=0;
    Object.assign(this.material.uniforms,{
      uColumnTileOrigin:{value:new THREE.Vector2()},uColumnTargetOrigin:{value:new THREE.Vector2()},
      uColumnFootprintStart:{value:0},uColumnFootprintCount:{value:0},
      uColumnPreviousTotal:{value:this.scratch.targets[1].textures[0]},
      uColumnPreviousMoments:{value:this.scratch.targets[1].textures[1]},
      uColumnPreviousJoint:{value:this.scratch.targets[1].textures[2]},
    });
    // A single immutable source and binding dictionary owns the whole tile.
    // Do not clone uniforms: render-target samplers cannot be cloned and the
    // source snapshots must not acquire another upload/ownership wrapper.
    this.finalMaterial=new THREE.ShaderMaterial({defines:{...this.material.defines,COLUMN_TILE_FINAL:1},
      uniforms:this.material.uniforms,glslVersion:this.material.glslVersion,
      vertexShader:this.material.vertexShader,fragmentShader:this.material.fragmentShader,
      depthTest:false,depthWrite:false,blending:THREE.NoBlending});
    this.quad=new OwnedScreenTriangle(this.material);
  }
  sourcesCurrent() {
    return this.fieldOwner===this.planet.weatherField
      &&this.speciesMask===this.planet.volCloudMat.uniforms.uSpeciesMask.value
      &&(!this.weatherSources||weatherSourcesCurrent(this.weatherSources,this.planet.weatherStream));
  }
  invalidate(reason) {
    if(this.ready||this.disposed)return;
    this.invalidated=true;this.reason=reason;
    this.scratch.release(this,this.lease);this.lease=null;this.footprintCursor=0;this.scratchIndex=-1;
  }
  admission() {
    // First uploads/program/target use are not recurring integration draws.
    // Do not let a batch cross the first final-variant use under a warm key.
    if(this.ready||this.disposed||this.invalidated)return {phase:'idle',maxUnits:0};
    const untilFinal=Math.ceil((this.footprintSamples-this.footprintCursor)/this.footprintBatch);
    if(untilFinal>1&&!this.startedWork)return {phase:'initialize-work',maxUnits:1};
    if(!this.startedFinal) {
      if(untilFinal===1)return {phase:'initialize-final',maxUnits:1};
      return {phase:'production',maxUnits:untilFinal-1};
    }
    return {phase:'production',maxUnits:Number.MAX_SAFE_INTEGER};
  }
  bakeWork(renderer,quanta=1) {
    if(!Number.isInteger(quanta)||quanta<0)throw Error('Column work grant must be a nonnegative draw count');
    const result={draws:0,committedRows:0,row:this.row,footprintCursor:this.footprintCursor,
      ready:this.ready,invalidated:this.invalidated,disposed:this.disposed,blocked:false};
    if(this.ready||this.disposed||this.invalidated||quanta===0)return result;
    if(this.inWork)return {...result,blocked:true};
    if(!this.sourcesCurrent()){this.invalidate('source-replaced');return {...result,invalidated:true,footprintCursor:0};}
    if(this.renderer&&this.renderer!==renderer)throw Error('Column work cannot cross renderers');
    if(this.contextEpoch!==null&&this.contextEpoch!==this.scratch.epoch) {
      this.invalidate('context-epoch');return {...result,invalidated:true,footprintCursor:0};
    }
    const savedTarget=renderer.getRenderTarget(),autoClear=renderer.autoClear;
    const face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel(),started=performance.now();
    this.inWork=true;
    try {
      for(let quantum=0;quantum<quanta&&!this.ready;quantum++) {
        const lease=this.scratch.acquire(this,renderer);
        if(lease===null){result.blocked=true;break;}
        this.lease=lease;this.renderer=renderer;this.contextEpoch=this.scratch.epoch;
        const count=Math.min(this.footprintBatch,this.footprintSamples-this.footprintCursor);
        const final=this.footprintCursor+count===this.footprintSamples;
        const rows=Math.min(this.tileRows,this.height-this.row),next=this.scratchIndex===0?1:0;
        const previous=this.scratch.targets[this.scratchIndex<0?1:this.scratchIndex];
        const target=final?this.target:this.scratch.targets[next];
        const material=final?this.finalMaterial:this.material,u=material.uniforms;
        u.uColumnTileOrigin.value.set(0,this.row);u.uColumnTargetOrigin.value.set(0,final?this.row:0);
        u.uColumnFootprintStart.value=this.footprintCursor;u.uColumnFootprintCount.value=count;
        u.uColumnPreviousTotal.value=previous.textures[0];u.uColumnPreviousMoments.value=previous.textures[1];
        u.uColumnPreviousJoint.value=previous.textures[2];
        target.viewport.set(0,0,this.width,final?this.height:this.scratch.rows);
        target.scissor.set(0,final?this.row:0,this.width,rows);target.scissorTest=true;
        renderer.autoClear=false;renderer.setRenderTarget(target);
        this.quad.material=material;this.scratch.beginDraw(this);
        try {
          this.quad.render(renderer);result.draws++;
          if(final)this.startedFinal=true;else this.startedWork=true;
        }
        finally {this.scratch.endDraw(this);}
        if(this.disposed||this.invalidated||!this.sourcesCurrent()||renderer.getContext().isContextLost()) {
          this.invalidate('submission-invalidated');break;
        }
        if(final) {
          this.row+=rows;result.committedRows+=rows;this.footprintCursor=0;this.scratchIndex=-1;
          this.scratch.release(this,this.lease);this.lease=null;
          if(this.row===this.height)this.finish();
        } else {this.footprintCursor+=count;this.scratchIndex=next;}
      }
    } catch(error) {
      // An uncertain draw may have written its target. Restart this whole tile
      // with p=0 rather than reading a partially updated accumulator on retry.
      this.scratch.release(this,this.lease);this.lease=null;this.footprintCursor=0;this.scratchIndex=-1;
      throw error;
    } finally {
      this.inWork=false;
      renderer.setRenderTarget(savedTarget,face,mip);renderer.autoClear=autoClear;
      this.uploadMs.push(performance.now()-started);
      if(this.disposed)this.releaseResources();
    }
    return {...result,row:this.row,footprintCursor:this.footprintCursor,ready:this.ready,invalidated:this.invalidated,disposed:this.disposed};
  }
  releasePrograms() {
    for(const [key,material] of [['tileWork',this.material],['tileFinal',this.finalMaterial]]) {
      if(!material)continue;
      for(const name of Object.keys(material.uniforms))delete material.uniforms[name];
      if(this.programOwner&&!this.programOwner.retired&&!this.programOwner[key])this.programOwner[key]=material;
      else material.dispose();
    }
    this.material=null;this.finalMaterial=null;
  }
  finish() {
    this.ready=true;
    for(const texture of this.snapshots)texture.dispose();this.snapshots=[];
    this.releasePrograms();this.quad.dispose();this.quad=null;
    if(this.ownsScratch)this.scratch.dispose();
  }
  dispose() {
    if(this.disposed)return;this.disposed=true;
    this.scratch.release(this,this.lease);this.lease=null;this.footprintCursor=0;this.scratchIndex=-1;
    if(!this.inWork)this.releaseResources();
  }
  releaseResources() {
    if(this.resourcesReleased)return;this.resourcesReleased=true;
    this.target.dispose();this.releasePrograms();this.quad?.dispose();this.quad=null;
    for(const texture of this.snapshots)texture.dispose();this.snapshots=[];
    if(this.ownsScratch)this.scratch.dispose();
  }
}
