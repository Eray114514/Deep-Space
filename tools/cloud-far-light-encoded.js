import { OwnedScreenTriangle } from '../src/owned-screen-triangle.js';
import { compilePrograms } from '../src/program-preparation.js';
import { createCompileCamera } from '../src/render-prewarm.js';
import { VOLUME_LAYER } from '../src/render-layers.js';

const closureStart='      float cloudMultipleSource(';
const closureEnd='      float cloudVerticalAbove=';

const radialSampler=`      uniform sampler2D uEncodedRadial;
      uniform bool uEncodedRadialReady;
      vec3 encodedRadialSource=vec3(-1);
      vec3 encodedRadialPlane(vec2 uv,float layer) {
        vec2 size=vec2(textureSize(uEncodedRadial,0));
        float cellSize=size.x/32.0;
        float tile=clamp(layer,0.0,uSunCacheDepth-1.0);
        vec2 cell=vec2(mod(tile,32.0),floor(tile/32.0));
        vec2 inner=clamp(uv,vec2(.5/cellSize),vec2(1.0-.5/cellSize));
        return textureLod(uEncodedRadial,(cell+inner)*cellSize/size,0.0).rgb;
      }
      vec3 encodedSlope(vec3 slope,vec3 delta) {
        vec3 value;
        for(int i=0;i<3;i++)value[i]=abs(delta[i])<.000001?0.0:clamp(slope[i]/delta[i],0.0,3.0)*delta[i];
        return value;
      }
      bool encodedRadialAt(vec3 local,out vec3 source) {
        source=vec3(-1);
        if(!uEncodedRadialReady)return false;
        vec3 coordinate=(uSunCacheMatrixA[2]*vec4(local,1)).xyz;
        float margin=uSunCacheMarginA[2],mz=.5/uSunCacheDepth;
        if(any(lessThan(coordinate,vec3(margin,margin,mz)))
          ||any(greaterThan(coordinate,vec3(1.0-margin,1.0-margin,1.0-mz))))return false;
        float z=coordinate.z*uSunCacheDepth-.5,k=floor(z),t=fract(z);
        vec3 a=encodedRadialPlane(coordinate.xy,k-1.0),b=encodedRadialPlane(coordinate.xy,k);
        vec3 c=encodedRadialPlane(coordinate.xy,k+1.0),d=encodedRadialPlane(coordinate.xy,k+2.0);
        vec3 delta=c-b,m0=encodedSlope((c-a)*.5,delta),m1=encodedSlope((d-b)*.5,delta);
        float t2=t*t,t3=t2*t;
        source=max(vec3(0),(2.0*t3-3.0*t2+1.0)*b+(t3-2.0*t2+t)*m0
          +(-2.0*t3+3.0*t2)*c+(t3-t2)*m1);
        return true;
      }
`;

function replace(source,anchor,replacement) {
  if(source.split(anchor).length!==2)throw Error('Missing encoded light shader boundary');
  return source.replace(anchor,replacement);
}

function encodedShader(source) {
  const decode='    float oa=uSunCacheEncoded>.5?exp(clamp(va,0.0,1.0)*log(129.0))-1.0:va;';
  let shader=replace(source,decode,`    if(uSunCacheEncoded>1.5 && field<2) {
      opticalDepth=-log(max(va,1e-14));
      return true;
    }
`+decode);
  shader=replace(shader,closureEnd,radialSampler+closureEnd);
  shader=replace(shader,'vec3 sunColor, float sunEnergy, float sunOD) {',
    'vec3 sunColor, float sunEnergy, float sunOD, int star) {');
  shader=replace(shader,'+ cloudMultipleSource(cloudVerticalAbove,cloudVerticalTotal,max(sunElevation,0.01));',
    `+ (encodedRadialSource.x>=0.0?encodedRadialSource[star+1]
              :cloudMultipleSource(cloudVerticalAbove,cloudVerticalTotal,max(sunElevation,0.01)));`);
  shader=replace(shader,'skyAmbient *= exp(-cloudVerticalAbove);',
    'skyAmbient *= encodedRadialSource.x>=0.0?encodedRadialSource.x:exp(-cloudVerticalAbove);');
  shader=replace(shader,'        vec4 depths=vec4(0);',
    '        vec4 depths=vec4(0);\n        encodedRadialSource=vec3(-1);');
  shader=replace(shader,'          float pathDepth=0.0;',
    `          if(path==2 && encodedRadialAt(local,encodedRadialSource))continue;
          if(path==3 && encodedRadialSource.x>=0.0)continue;
          float pathDepth=0.0;`);
  return replace(shader,'star==0?uSunEnergy:uSecondarySunEnergy,depths[star]);',
    'star==0?uSunEnergy:uSecondarySunEnergy,depths[star],star);');
}

// The diagnostics bind a single frozen snapshot. Solar transmission occupies
// two R16F fields. One RGBA16F radial field packs ambient and both LUT outputs.
export function createEncodedFarLight(T,cache,original,mesh,camera,scene) {
  if(!cache.available.every(Boolean)||!cache.transforms[2].equals(cache.transforms[3])
    ||cache.interiorMargins[2]!==cache.interiorMargins[3])
    throw Error('Encoded light diagnostic requires common radial support');
  const start=original.fragmentShader.indexOf(closureStart),end=original.fragmentShader.indexOf(closureEnd,start);
  if(start<0||end<=start)throw Error('Missing production scattering closure');
  const material=new T.ShaderMaterial().copy(Object.assign(Object.create(original),{uniforms:{}}));
  material.fragmentShader=encodedShader(original.fragmentShader);
  const proxy=new T.Mesh(mesh.geometry,material);
  proxy.layers.set(VOLUME_LAYER);
  const compileCamera=createCompileCamera(camera,VOLUME_LAYER);
  const makeTarget=(fields,format)=>new T.WebGLRenderTarget(cache.size*32,cache.size*Math.ceil(fields*cache.depth/32),{
    format,type:T.HalfFloatType,minFilter:T.LinearFilter,magFilter:T.LinearFilter,depthBuffer:false,
  });
  const solar=makeTarget(2,T.RedFormat),radial=makeTarget(1,T.RGBAFormat);
  Object.assign(material.uniforms,original.uniforms,{
    uEncodedRadial:{value:radial.texture},uEncodedRadialReady:{value:false},
  });
  const encoder=new T.ShaderMaterial({
    uniforms:{uDepth:{value:cache.depth},uSize:{value:cache.size},uOptics:{value:cache.target.texture},
      uCloudScattering:original.uniforms.uCloudScattering,uRadial:{value:false},
      uCacheCenter:{value:cache.center},uCacheBasis:{value:cache.frames[2]},
      uPitch:{value:new T.Vector2(cache.spacing,cache.verticalSpacing)},
      uDirection0:{value:cache.directions[0]},uDirection1:{value:cache.directions[1]}},
    vertexShader:'void main(){gl_Position=vec4(position.xy,0,1);}',
    fragmentShader:`precision highp sampler3D;uniform sampler3D uCloudScattering;
      uniform sampler2D uOptics;uniform int uSize,uDepth;uniform bool uRadial;
      uniform vec3 uCacheCenter,uDirection0,uDirection1;
      uniform mat3 uCacheBasis;uniform vec2 uPitch;
      ${original.fragmentShader.slice(start,end)}
      ivec2 atlasPixel(int tile,ivec2 pixel) {
        return ivec2(tile%32,tile/32)*uSize+pixel;
      }
      void main() {
        ivec2 pixel=ivec2(gl_FragCoord.xy),cell=pixel/uSize,local=pixel-cell*uSize;
        if(!uRadial) {
          gl_FragColor=vec4(exp(-texelFetch(uOptics,pixel,0).r),0,0,1);
          return;
        }
        int layer=cell.y*32+cell.x;
        float above=texelFetch(uOptics,atlasPixel(2*uDepth+layer,local),0).r;
        float below=texelFetch(uOptics,atlasPixel(3*uDepth+layer,local),0).r;
        vec3 q=vec3((vec2(local)+.5-float(uSize)*.5)*uPitch.x,
          (float(layer)+.5-float(uDepth)*.5)*uPitch.y);
        vec3 up=normalize(uCacheCenter+uCacheBasis*q);
        gl_FragColor=vec4(exp(-above),cloudMultipleSource(above,above+below,dot(up,uDirection0)),
          cloudMultipleSource(above,above+below,dot(up,uDirection1)),1);
      }`,
    depthTest:false,depthWrite:false,blending:T.NoBlending,
  });
  const quad=new OwnedScreenTriangle(encoder);
  return {material,solar,radial,
    compile(renderer,pointTarget) {
      renderer.setRenderTarget(pointTarget);
      return compilePrograms(renderer,proxy,compileCamera,scene);
    },
    encode(renderer) {
      for(const [target,radialField] of [[solar,false],[radial,true]]) {
        encoder.uniforms.uRadial.value=radialField;encoder.uniformsNeedUpdate=true;
        renderer.setRenderTarget(target);quad.render(renderer);
      }
    },
    dispose() {quad.dispose();encoder.dispose();solar.dispose();radial.dispose();material.dispose();},
  };
}
