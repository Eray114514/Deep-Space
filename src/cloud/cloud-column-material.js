import * as THREE from 'three';
import { captureWeatherSources } from './weather-sources.js';
import { cloudColumnFragmentGLSL } from './cloud-column-shader.js';

// Capture one immutable weather source; all work on the map shares it.
export function createCloudColumnMaterial(planet,{width,samples,footprintSamples,hours,tiled=false}) {
  const height=width/2;
  const weatherSources=planet.weatherStream?captureWeatherSources(planet.weatherStream,[hours]):null;
  const source=planet.volCloudMat;
  const snapshots=[];
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
    snapshots.push(texture); uniforms[name]={value:texture};
  }
  const material=new THREE.ShaderMaterial({
    defines:{...source.defines},
    glslVersion:THREE.GLSL3,
    uniforms:{...uniforms,uSpin:{value:new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(
      -(planet.cloudSpinBase+hours*planet.weatherField.windRadiansPerHour)))},
      uSpeciesMask:{value:source.uniforms.uSpeciesMask.value},
      uCloudAdvectionPhase:{value:hours*planet.weatherField.windRadiansPerHour},
      uColumnSize:{value:new THREE.Vector2(width,height)},uColumnSamples:{value:samples},
      uFootprintSamples:{value:footprintSamples}},
    vertexShader:'varying vec3 vDirection,vViewDirection;void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}',
    fragmentShader:cloudColumnFragmentGLSL({tiled}),depthTest:false,depthWrite:false,blending:THREE.NoBlending,
  });
  return {material,snapshots,weatherSources};
}
