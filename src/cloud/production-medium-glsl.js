import { productionSpeciesGLSL } from './production-shape.js';
// Point density has no observer/quality input. Angular filtering belongs to
// the column representation, after nonlinear density and Beer transmission.
export const productionCloudGLSL = /* glsl */`
  float cloudFootprint=0.0;
  vec2 cloudNoiseAt(vec3 p,float tileMeters) {
    return textureLod(uNoise3,p/tileMeters,0.0).rg;
  }
  ${productionSpeciesGLSL}
  vec2 productionCloudLayersAt(vec3 local) {return productionSpeciesAt(local);}
`;

// Only the production near volume uses the derived texture. Keep the shared
// source literal for far, terrain, and the sunlight-cache producers.
const scanStart=productionCloudGLSL.indexOf('    if(texelFetch(uBandCandidates,ivec3(cell,layer),0).r!=0u)return 0.0;');
const scanEnd=productionCloudGLSL.indexOf('    float distance=min(radius-below,above-radius);',scanStart);
const maskRead='      candidates=texelFetch(uBandCandidates,ivec3(cell,clamp(int(floor(altitude/500.0)),0,size.z-1)),0).r;';
if(scanStart<0||scanEnd<0||productionCloudGLSL.split(maskRead).length!==2)
  throw Error('Missing production near candidate layout boundaries');
export const nearProductionCloudGLSL=(productionCloudGLSL.slice(0,scanStart)+/* glsl */`    uint candidate=texelFetch(uBandCandidates,ivec3(cell,layer),0).r;
    if((candidate&32768u)==0u)return 0.0;
    uint lower=candidate&127u,upper=(candidate>>7u)&127u;
    float below=lower==0u?uRin:max(uRin,uBodyR+float(lower)*500.0);
    float above=upper==0u?uRout:min(uRout,uBodyR+float(upper-1u)*500.0);
`+productionCloudGLSL.slice(scanEnd))
  .replace(maskRead,`${maskRead}\n      if((candidates&32768u)!=0u)return vec2(0);`)
  .replaceAll(/\buBandCandidates\b/g,'uNearBandCandidates');
