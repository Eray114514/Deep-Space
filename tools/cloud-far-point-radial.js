function once(source,from,to) {
  if (source.split(from).length!==2) throw Error('Expected one Far radial shader boundary');
  return source.replace(from,to);
}

// Only a radial fallback beam can borrow its origin's angular address.
// Keep the original positions for noise, altitude, empty-ball distances,
// quadrature spacing, clipping and integration.
export function farPointRadialShader(source) {
  const species='  vec2 productionSpeciesAt(vec3 local) {';
  const empty='  float productionEmptyRadius(vec3 local) {';
  const fallback='          if(!cached)pathDepth=cloudSunOpticalDepthLimit(local,direction,sigma,path<2?12.0:128.0);';
  let shader=once(source,empty,`  uniform int uPointRadialMode;
  bool pointRadialAtlas=false,pointRadialEmpty=false;
  vec2 pointRadialUv,pointRadialBounds;
  float pointRadialSurface;
  ivec2 pointRadialCell=ivec2(0);
`+empty);
  const speciesStart=shader.indexOf(species);
  const speciesEnd=shader.indexOf('    return total;\n  }',speciesStart);
  if (speciesStart<0 || speciesEnd<=speciesStart) throw Error('Missing production species function');
  const before=shader.slice(0,speciesStart);
  let body=shader.slice(speciesStart,speciesEnd);
  body=once(body,'    vec2 bounds=productionAltitudeBounds(radial);',
    '    vec2 bounds=pointRadialAtlas?pointRadialBounds:productionAltitudeBounds(radial);');
  body=once(body,'    vec2 uv=weatherAtlasUV(weatherRadial);',
    '    vec2 uv=pointRadialAtlas?pointRadialUv:weatherAtlasUV(weatherRadial);');
  body=once(body,'    float surface=productionSurfaceAt(radial);',
    '    float surface=pointRadialAtlas?pointRadialSurface:productionSurfaceAt(radial);');
  shader=once(before,`    vec2 uv=weatherAtlasUV(point);
    ivec2 cell=clamp(ivec2(floor(uv*vec2(size.xy))),ivec2(0),size.xy-1);`,`    ivec2 cell=pointRadialCell;
    if(!pointRadialEmpty) {
      vec2 uv=weatherAtlasUV(point);
      cell=clamp(ivec2(floor(uv*vec2(size.xy))),ivec2(0),size.xy-1);
    }`)+body+shader.slice(speciesEnd);
  return once(shader,fallback,`          if(!cached) {
            if(path>=2 && uPointRadialMode>0) {
              vec3 radial=local/length(local);
              vec3 weather=uSpin*radial;
              // Longitude is ill-conditioned close to the poles.
              if(dot(weather.xz,weather.xz)>0.00001 && dot(radial.xz,radial.xz)>0.00001) {
                vec2 uv=weatherAtlasUV(uPointRadialMode==1?weather:uSpin*local);
                ivec3 size=textureSize(uBandCandidates,0);
                vec2 cellPosition=uv*vec2(size.xy),f=fract(cellPosition);
                // The same angular candidate bin must cover the whole beam.
                if(all(greaterThan(f,vec2(.002))) && all(lessThan(f,vec2(.998)))) {
                  if(uPointRadialMode==1) {
                    pointRadialAtlas=true;
                    pointRadialUv=uv;
                    pointRadialBounds=productionAltitudeBounds(radial);
                    pointRadialSurface=productionSurfaceAt(radial);
                  } else {
                    pointRadialEmpty=true;
                    pointRadialCell=clamp(ivec2(floor(cellPosition)),ivec2(0),size.xy-1);
                  }
                }
              }
            }
            pathDepth=cloudSunOpticalDepthLimit(local,direction,sigma,path<2?12.0:128.0);
            pointRadialAtlas=false;
            pointRadialEmpty=false;
          }`);
}
