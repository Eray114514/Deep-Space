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
