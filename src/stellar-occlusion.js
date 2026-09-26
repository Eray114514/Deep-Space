import * as THREE from 'three';

export const MAX_STELLAR_OCCLUDERS = 16;

// Select for the whole optical/cloud envelope and BOTH stars, never the camera.
// Exceeding the explicit shader capacity is an error, not silent loss of moons.
export function selectStellarOccluders(planet, bodies, stars) {
  const envelope = Math.max(planet.R + 120000, planet.volCloudBand?.rOut || 0);
  const selected = [];
  for (const body of bodies) {
    if (body === planet) continue;
    const offset = body.posUniv.clone().sub(planet.posUniv);
    const relevant = stars.some((star) => {
      const delta = star.positionUniv.clone().sub(planet.posUniv);
      const distance = delta.length(), direction = delta.multiplyScalar(1 / distance);
      const along = offset.dot(direction);
      if (along + envelope + body.R <= 0 || along - envelope - body.R >= distance) return false;
      const perpendicular = offset.clone().addScaledVector(direction, -along).length();
      return perpendicular <= envelope + body.R + Math.max(0, along) * star.spec.radiusRender / distance;
    });
    if (relevant) selected.push({ centerLocal: planet.worldOffsetToLocal(offset, new THREE.Vector3()), radius: body.R });
  }
  if (selected.length > MAX_STELLAR_OCCLUDERS) throw Error('Stellar occluder capacity exceeded');
  return selected;
}

export function stellarOcclusionUniforms() {
  return {
    uLocalStarCount: { value: 0 },
    uLocalStars: { value: [new THREE.Vector4(), new THREE.Vector4()] },
    uLocalOccluderCount: { value: 0 },
    uLocalOccluders: { value: Array.from({ length: MAX_STELLAR_OCCLUDERS }, () => new THREE.Vector4()) },
  };
}

export function bindStellarOcclusion(uniforms, planet) {
  if (!uniforms?.uLocalStarCount) return;
  const sources = planet.stellarLightField?.sources || [];
  uniforms.uLocalStarCount.value = Math.min(2, sources.length);
  for (let i = 0; i < 2; i++) {
    const source = sources[i];
    const direction = source?.localDirection || planet.sunDirLocal;
    const distance = source?.distance || 1e12;
    uniforms.uLocalStars.value[i].set(direction.x * distance, direction.y * distance, direction.z * distance,
      source?.radius || 0);
  }
  const blockers = planet.stellarOccluders || [];
  uniforms.uLocalOccluderCount.value = blockers.length;
  blockers.forEach((b, i) => uniforms.uLocalOccluders.value[i].set(b.centerLocal.x, b.centerLocal.y, b.centerLocal.z, b.radius));
}

export const stellarOcclusionGLSL = /* glsl */`
  uniform int uLocalStarCount, uLocalOccluderCount;
  uniform vec4 uLocalStars[2], uLocalOccluders[${MAX_STELLAR_OCCLUDERS}];
  float localStellarVisibility(vec3 position, vec3 direction) {
    if(uLocalStarCount == 0 || uLocalOccluderCount == 0) return 1.0;
    int star=0;
    if(uLocalStarCount>1 && dot(normalize(uLocalStars[1].xyz),direction)
      >dot(normalize(uLocalStars[0].xyz),direction)) star=1;
    vec3 delta=uLocalStars[star].xyz-position;
    float distance=length(delta), starAngle=asin(clamp(uLocalStars[star].w/distance,0.0,0.9999));
    vec3 sun=delta/distance;
    vec3 axis=abs(sun.y)<0.9?vec3(0,1,0):vec3(1,0,0);
    vec3 x=normalize(cross(sun,axis)), y=cross(sun,x);
    vec3 discs[${MAX_STELLAR_OCCLUDERS}];
    int count=0;
    for(int i=0;i<${MAX_STELLAR_OCCLUDERS};i++) {
      if(i>=uLocalOccluderCount) break;
      vec3 v=uLocalOccluders[i].xyz-position;
      float d=length(v), along=dot(v,sun), radius=uLocalOccluders[i].w;
      if(d<=radius) return 0.0;
      if(along<=0.0 || along>=distance) continue;
      float angle=asin(clamp(radius/d,0.0,0.9999));
      vec3 n=v/d;
      float separation=acos(clamp(dot(n,sun),-1.0,1.0));
      if(separation>=angle+starAngle) continue;
      if(angle>=separation+starAngle) return 0.0;
      float tangentLength=max(length(vec2(dot(n,x),dot(n,y))),1e-9);
      discs[count++]=vec3(vec2(dot(n,x),dot(n,y))*separation/tangentLength,angle);
    }
    if(count==0) return 1.0;
    // Deterministic equal-area stellar-disc quadrature; union coverage avoids
    // double-counting overlapping occluders. Only partial eclipses reach here.
    float visible=0.0;
    for(int j=0;j<64;j++) {
      float radius=starAngle*sqrt((float(j)+0.5)/64.0), phi=float(j)*2.39996323;
      vec2 samplePoint=radius*vec2(cos(phi),sin(phi));
      float transmission=1.0;
      for(int i=0;i<${MAX_STELLAR_OCCLUDERS};i++) {
        if(i>=count) break;
        float edge=max(starAngle*0.08,1e-7);
        transmission=min(transmission,smoothstep(-edge,edge,length(samplePoint-discs[i].xy)-discs[i].z));
      }
      visible+=transmission/64.0;
    }
    return visible;
  }
`;
