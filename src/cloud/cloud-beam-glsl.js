// One cloud sunlight quadrature for the volume and direct surface lighting.
// The host supplies cloudExtinctionAt, sphereHits and metre radii.
export const cloudBeamGLSL = /* glsl */`
  float cloudBeamIterations=0.0,cloudBeamDensitySamples=0.0,cloudBeamEmptyMeters=0.0;
  float cloudSunOpticalDepthLimit(vec3 local,vec3 sunDirection,float sigma,float maximumOD) {
    cloudBeamIterations=0.0;cloudBeamDensitySamples=0.0;cloudBeamEmptyMeters=0.0;
    // Ground occlusion is handled by the lighting owner. A cache node beneath
    // the opaque body has no participating cloud column to integrate.
    if(length(local)<=uGroundR)return 0.0;
    float end=max(0.0,sphereHits(local,uRout,sunDirection).y);
    vec2 ground=sphereHits(local,uGroundR,sunDirection);
    if(ground.x>0.0)end=min(end,ground.x);
    float refinement=12.0/max(uCloudLightSteps,4.0),od=0.0,t=0.0;
    // Resolve the thinnest physical cloud structure all along the beam. A
    // logarithmic 12-cell schedule can skip a whole 600 m deck farther away.
    // Work ends only at the shell/opaque boundary or negligible transmission.
    for(int j=0;j<8192;j++) {
      if(t>=end || od>=maximumOD)break;
      cloudBeamIterations+=1.0;
      vec3 point=local+sunDirection*t;
      float radialRate=abs(dot(normalize(point),sunDirection));
      float stepMeters=min(200.0,80.0/max(radialRate,0.08))*refinement;
      float dt=min(end-t,stepMeters);
      float emptyRadius=productionEmptyRadius(point);
      if(emptyRadius>dt) {
        float skip=min(end-t,emptyRadius);t+=skip;cloudBeamEmptyMeters+=skip;continue;
      }
      // Three-point Gauss integration resolves rounded thin cell boundaries
      // without increasing the physical traversal length of a step.
      cloudBeamDensitySamples+=3.0;
      float weighted=0.0;
      // A uniform loop keeps one density kernel in ANGLE/D3D's generated
      // shader instead of inlining the complete species kernel three times.
      for(int node=0;node<int(max(uCloudLightSteps,4.0));node++) {
        if(node>=3)break;
        float location=node==0?.1127016654:node==1?.5:.8872983346;
        weighted+=cloudExtinctionAt(point+sunDirection*(dt*location),sigma)*(node==1?8.0:5.0);
      }
      od+=weighted*dt/18.0;
      t+=dt;
    }
    return min(od,maximumOD);
  }
  float cloudSunOpticalDepth(vec3 local,vec3 sunDirection,float sigma) {
    return cloudSunOpticalDepthLimit(local,sunDirection,sigma,12.0);
  }
`;
