// For production direct single scattering the optical-depth term is exp(-tau).
// Bound the maximum linear RGB contribution before attenuation. Atmospheric
// transmission, visibility and receiver opacity can only reduce this bound.
export function farPointSolarTailShader(source) {
  const original = '          if(!cached)pathDepth=cloudSunOpticalDepthLimit(local,direction,sigma,path<2?12.0:128.0);';
  if (source.split(original).length!==2) throw Error('Expected one production optical-depth fallback');
  return 'uniform float uPointSolarTail;\n'+source.replace(original,`          if(!cached) {
            float limit=path<2?12.0:128.0;
            if(path<2 && uPointSolarTail>0.0) {
              vec3 rgb=abs((path==0?uSunC:uSecondarySunC)*uTint);
              float energy=abs(path==0?uSunEnergy:uSecondarySunEnergy);
              float mu=clamp(dot(dir,direction),-1.0,1.0);
              float phase=mix(cloudPhase(mu,-0.25),cloudPhase(mu,0.65),0.80);
              float gain=max(max(rgb.r,rgb.g),rgb.b)*energy*abs(uStellarRadianceScale)*phase;
              limit=min(12.0,log(max(gain,uPointSolarTail)/uPointSolarTail));
            }
            pathDepth=cloudSunOpticalDepthLimit(local,direction,sigma,limit);
          }`);
}
