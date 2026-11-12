// One cloud sunlight quadrature for the volume and direct surface lighting.
// The host supplies cloudExtinctionAt, sphereHits and metre radii.
export const cloudBeamGLSL = /* glsl */`
  float cloudBeamIterations=0.0,cloudBeamDensitySamples=0.0,cloudBeamEmptyMeters=0.0;
  float cloudBeamLodScale=1.0;
  float cloudSunOpticalDepthLimit(vec3 local,vec3 sunDirection,float sigma,float maximumOD) {
    cloudBeamIterations=0.0;cloudBeamDensitySamples=0.0;cloudBeamEmptyMeters=0.0;
    // Ground occlusion is handled by the lighting owner. A cache node beneath
    // the opaque body has no participating cloud column to integrate.
    if(length(local)<=uGroundR)return 0.0;
    float end=max(0.0,sphereHits(local,uRout,sunDirection).y);
    vec2 ground=sphereHits(local,uGroundR,sunDirection);
    if(ground.x>0.0)end=min(end,ground.x);
    bool radialDiffuse=maximumOD>16.0;
    float lodScale=cloudBeamLodScale*(radialDiffuse?1.0+smoothstep(1.5,3.5,cloudBeamLodScale):1.0);
    float refinement=(12.0/max(uCloudLightSteps,4.0))*lodScale,od=0.0,t=0.0;
    for(int j=0;j<8192;j++) {
      if(t>=end || od>=maximumOD)break;
      cloudBeamIterations+=1.0;
      vec3 point=local+sunDirection*t;
      float radialRate=radialDiffuse?1.0:abs(dot(normalize(point),sunDirection));
      float stepMeters=min(200.0,80.0/max(radialRate,0.08))*refinement;
      float singleOdThreshold=mix(1.8,0.35,smoothstep(1.5,3.0,cloudBeamLodScale));
      if(od>=singleOdThreshold*2.0)stepMeters*=2.0;
      float dt=min(end-t,stepMeters);
      float emptyRadius=productionEmptyRadius(point);
      if(emptyRadius>dt) {
        float skip=min(end-t,emptyRadius);t+=skip;cloudBeamEmptyMeters+=skip;continue;
      }
      bool singleNode=radialDiffuse || od>=singleOdThreshold;
      cloudBeamDensitySamples+=singleNode?1.0:3.0;
      float weighted=0.0;
      // A uniform loop keeps one density kernel in ANGLE/D3D's generated
      // shader instead of inlining the complete species kernel three times.
      for(int node=0;node<int(max(uCloudLightSteps,4.0));node++) {
        if(node>=(singleNode?1:3))break;
        float location=singleNode?0.5:(node==0?.1127016654:node==1?.5:.8872983346);
        weighted+=cloudExtinctionAt(point+sunDirection*(dt*location),sigma)*(singleNode?18.0:(node==1?8.0:5.0));
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
