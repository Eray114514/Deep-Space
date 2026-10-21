import * as THREE from 'three';
import { productionColumnCondensateGLSL } from './production-shape.js';
import { OwnedScreenTriangle as FullScreenQuad } from '../owned-screen-triangle.js';
import { productionCloudGLSL } from './production-medium-glsl.js';
import { weatherAtlasGLSL } from './weather-atlas.js';
import { captureWeatherSources } from './weather-sources.js';

// Opacity, not averaged noise, is filtered for unresolved cloud cells. Columns
// are baked from the production density kernel; no independent cloud layout.
export class CloudColumnMap {
  constructor(planet, { width=1024, samples=128, footprintSamples=64, hours=planet.weatherHours, programOwner=null }={}) {
    this.planet=planet; this.width=width; this.height=width/2;
    this.samples=samples; this.footprintSamples=footprintSamples;
    this.row=0; this.ready=false; this.disposed=false;
    this.programOwner=programOwner;
    this.weatherSources=planet.weatherStream?captureWeatherSources(planet.weatherStream,[hours]):null;
    this.target=new THREE.WebGLRenderTarget(width,this.height,{depthBuffer:false,count:2,
      type:THREE.UnsignedByteType,minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter});
    this.target.textures[1].type=THREE.HalfFloatType;
    this.target.textures[1].format=THREE.RGBAFormat;
    for(const texture of this.target.textures){texture.wrapS=THREE.RepeatWrapping;texture.colorSpace=THREE.NoColorSpace;}
    const source=planet.volCloudMat;
    this.snapshots=[];
    const uniforms={...source.uniforms};
    for(const name of ['uWeatherMap','uWeatherMapHi','uSpeciesMap','uBandBounds']) {
      const original=source.uniforms[name].value,image=original.image;
      const frame=planet.weatherStream?.frames.get(hours);
      const key={uWeatherMap:'low',uWeatherMapHi:'high',uSpeciesMap:'bands',uBandBounds:'bounds'}[name];
      let bytes=frame?.[key]?.slice() || image.data.slice();
      if(frame && (name==='uWeatherMap' || name==='uWeatherMapHi')) {
        const flipped=new Float32Array(bytes.length);
        for(let y=0;y<image.height;y++)flipped.set(bytes.subarray(y*image.width*4,(y+1)*image.width*4),(image.height-1-y)*image.width*4);
        bytes=flipped;
      }
      const texture=name==='uSpeciesMap'
        ? new THREE.DataArrayTexture(bytes,image.width,image.height,image.depth)
        : new THREE.DataTexture(bytes,image.width,image.height,original.format,frame?THREE.FloatType:original.type);
      texture.format=original.format;texture.type=frame?THREE.FloatType:original.type;
      texture.wrapS=THREE.RepeatWrapping;texture.wrapT=THREE.ClampToEdgeWrapping;
      texture.minFilter=texture.magFilter=name==='uSpeciesMap'?THREE.LinearFilter:THREE.NearestFilter;texture.needsUpdate=true;
      this.snapshots.push(texture); uniforms[name]={value:texture};
    }
    const prefix=`precision highp sampler3D;uniform sampler3D uNoise3;
      uniform sampler2D uWeatherMapHi;uniform mat3 uSpin;
      uniform vec3 uCOff;uniform float uBodyR,uSurfaceRange,uRin,uRout;
      ${weatherAtlasGLSL}\n${productionCloudGLSL}${productionColumnCondensateGLSL}`;
    this.material=new THREE.ShaderMaterial({
      defines:{...source.defines},
      glslVersion:THREE.GLSL3,
      uniforms:{...uniforms,uSpin:{value:new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(
        -(planet.cloudSpinBase+hours*planet.weatherField.windRadiansPerHour)))},
        uSpeciesMask:{value:source.uniforms.uSpeciesMask.value},
        uCloudAdvectionPhase:{value:hours*planet.weatherField.windRadiansPerHour},
        uColumnSize:{value:new THREE.Vector2(width,this.height)},uColumnSamples:{value:samples},
        uFootprintSamples:{value:footprintSamples}},
      vertexShader:'varying vec3 vDirection,vViewDirection;void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}',
      fragmentShader:prefix+`
        uniform vec2 uColumnSize; uniform int uColumnSamples,uFootprintSamples;
        layout(location=0) out vec4 optical;
        layout(location=1) out vec4 heights;
        void main() {
          vec4 total=vec4(0);vec2 altitudeMoment=vec2(0),weightMoment=vec2(0);float jointOpacity=0.0;
          for(int p=0;p<uFootprintSamples;p++) {
            // Deterministic stratified footprint, without RNG/frame changes.
            vec2 offset=vec2((float(p)+0.5)/float(uFootprintSamples),
              fract((float(p)+0.5)*0.61803398875));
            vec2 uv=(floor(gl_FragCoord.xy)+offset)/uColumnSize;
            float latitude=(0.5-uv.y)*3.14159265359,longitude=uv.x*6.28318530718;
            vec3 weatherRadial=vec3(cos(latitude)*cos(longitude),sin(latitude),cos(latitude)*sin(longitude));
            vec3 radial=transpose(uSpin)*weatherRadial;
            float surface=productionSurfaceAt(radial);
            vec2 tau=vec2(0),moment=vec2(0);
            float speciesTau[16],speciesHeight[16];int speciesFamily[16];
            for(int species=0;species<int(uSpeciesCount);species++) {
              speciesTau[species]=0.0;speciesHeight[species]=0.0;speciesFamily[species]=0;
              if(uSpeciesMask>=0.0 && abs(uSpeciesMask-float(species))>.5)continue;
              vec4 shape=speciesShapeAt(species),parameters=speciesOpticsAt(species);
              if(shape.z>0.5)continue;
              vec4 band=productionBandAt(uv,species);
              band=speciesAbsoluteBand(band,shape,surface);
              if(band.r<=0.0)continue;
              float guard=(parameters.y+parameters.z)*0.5+2.0;
              float bottom=max(surface,band.g-guard),top=band.b+guard;
              int count=min(uColumnSamples,max(8,int(ceil((top-bottom)/80.0))));
              vec3 axis,frame;productionSpeciesFrame(weatherRadial,species,axis,frame);
              float stepMeters=(top-bottom)/float(count);
              float integrated=0.0,firstMoment=0.0;
              vec2 columnRegion=productionAreaBand(uv,species);
              float minimumDepth=speciesStructureAt(species).x;
              float columnAmount=columnSpeciesAmount(frame,band,columnRegion);
              for(int k=0;k<count;k++) {
                // A space-facing ray first interacts at the top of a dense
                // deck, not at its extinction-weighted interior centroid.
                float altitude=top-(float(k)+0.5)*stepMeters;
                float sigma=columnSpeciesCondensate(frame,axis,altitude,band,parameters.x,parameters.y,parameters.z,int(shape.x),minimumDepth,columnAmount)*parameters.w;
                float opticalDepth=sigma*stepMeters;
                firstMoment+=exp(-integrated)*(1.0-exp(-opticalDepth))*altitude;
                integrated+=opticalDepth;
              }
              int family=shape.y<.5?0:1;speciesFamily[species]=family;
              speciesTau[species]=integrated;
              speciesHeight[species]=firstMoment/max(1.0-exp(-integrated),1e-20);
              tau[family]+=integrated;
            }
            for(int species=0;species<int(uSpeciesCount);species++) {
              if(speciesTau[species]<=0.0)continue;
              float above=0.0;
              for(int other=0;other<int(uSpeciesCount);other++) {
                if(speciesFamily[other]!=speciesFamily[species])continue;
                if(speciesHeight[other]>speciesHeight[species]
                  || (speciesHeight[other]==speciesHeight[species] && other>species))above+=speciesTau[other];
              }
              moment[speciesFamily[species]]+=exp(-above)*(1.0-exp(-speciesTau[species]))*speciesHeight[species];
            }
            vec2 opacity=vec2(1)-exp(-tau);
            total+=vec4(opacity,tau);
            jointOpacity+=1.0-exp(-tau.x-tau.y);
            altitudeMoment+=moment;weightMoment+=opacity;
          }
          total/=float(uFootprintSamples);
          optical=vec4(total.xy,log(vec2(1)+total.zw)/log(129.0));
          heights=vec4(altitudeMoment/max(weightMoment,vec2(0.000001)),jointOpacity/float(uFootprintSamples),1);
        }`,depthTest:false,depthWrite:false,blending:THREE.NoBlending,
    });
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
    if(this.programOwner && !this.programOwner.columns)this.programOwner.columns=this.material;
    else this.material.dispose();
  }
  dispose() { if(this.disposed) return;this.disposed=true;this.target.dispose();this.releaseProgram();this.quad?.dispose();
    this.material=null;this.quad=null;
    for(const texture of this.snapshots)texture.dispose();this.snapshots=[]; }
}
