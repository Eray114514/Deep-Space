// Tool-only restructuring of the complete Far shader. Physical kernels,
// quadrature, thresholds and per-path arithmetic are retained.
import assert from 'node:assert/strict';

function once(source, before, after) {
  assert.equal(source.split(before).length, 2, 'Exact single front-transport anchor required: ' + before.slice(0, 70));
  return source.replace(before, after);
}

export function cloudColumnFrontCandidate(source) {
  let result = once(source,
    'vec4 cloudCachedColumn(vec3 dir,float start,float end) {',
    'vec4 cloudCachedColumn(vec3 dir,float start,float end,out float frontEnd) {\n        frontEnd=-1.0;');
  result = once(result,
    `        vec2 air=air_sphereHits(uCameraLocal,air_uTopR,dir);
        vec3 beforeL,beforeT,gapL=vec3(0),gapT=vec3(1);
        airIntegrate(uCameraLocal,dir,max(0.0,air.x),min(first,air.y),beforeL,beforeT);`,
    '        vec3 gapL=vec3(0),gapT=vec3(1);');
  result = once(result,
    `        vec3 correction=beforeL*(1.0-transmission)+beforeT*
          (nearLight*uTint+gapL*max(0.0,1.0-farT-crossOpacity)+gapT*farLight*uTint*farVisible);`,
    `        frontEnd=first;
        vec3 correction=nearLight*uTint+gapL*max(0.0,1.0-farT-crossOpacity)+gapT*farLight*uTint*farVisible;`);
  result = once(result,
    'vec4 cloudFarColumn(vec3 dir, float start, float end) {',
    'vec4 cloudFarColumn(vec3 dir, float start, float end,out float frontEnd) {\n        frontEnd=-1.0;');
  result = once(result,
    `        vec2 air=air_sphereHits(uCameraLocal,air_uTopR,dir);
        vec3 light,transmission;
        airIntegrate(uCameraLocal,dir,max(0.0,air.x),min(t,air.y),light,transmission);
        return vec4((light+transmission*source*uTint)*moment,moment);`,
    `        frontEnd=t;
        return vec4(source,moment);`);
  const start = '        #if PRODUCTION_CLOUD_MEDIUM && CLOUD_FAR_VIEW\n        {';
  const end = '        #else\n\n        float seg = t1 - t0;';
  assert.equal(result.split(start).length, 2);
  assert.equal(result.split(end).length, 2);
  const a = result.indexOf(start), b = result.indexOf(end, a);
  assert.ok(b > a);
  const dispatch = `        #if PRODUCTION_CLOUD_MEDIUM && CLOUD_FAR_VIEW
        {
          float footprint=rayCone*t0;
          #if CLOUD_FAR_CACHE
          bool cachedOnly=true,useCached=true;
          #else
          bool cachedOnly=uColumnsReady>0.5 && footprint>2400.0;
          bool useCached=uColumnsReady>0.5 && footprint>900.0;
          #endif
          vec4 pointColumn=vec4(0),cachedColumn=vec4(0);
          // Preserve point-before-cache execution. A dynamic range shares the
          // front atmosphere call while retaining each path's original algebra.
          for(int method=cachedOnly?1:0;method<(useCached?2:1);method++) {
            float frontEnd;
            vec4 payload;
            #if CLOUD_FAR_CACHE
            payload=cloudCachedColumn(dir,t0,t1,frontEnd);
            #else
            if(method==0)payload=cloudFarColumn(dir,t0,t1,frontEnd);
            else payload=cloudCachedColumn(dir,t0,t1,frontEnd);
            #endif
            vec3 light=vec3(0),transmission=vec3(1);
            if(frontEnd>=0.0) {
              vec2 air=air_sphereHits(uCameraLocal,air_uTopR,dir);
              airIntegrate(uCameraLocal,dir,max(0.0,air.x),min(frontEnd,air.y),light,transmission);
            }
            #if CLOUD_FAR_CACHE
            cachedColumn=vec4(light*payload.a+transmission*payload.rgb,payload.a);
            #else
            if(method==0)pointColumn=vec4((light+transmission*payload.rgb*uTint)*payload.a,payload.a);
            else cachedColumn=vec4(light*payload.a+transmission*payload.rgb,payload.a);
            #endif
          }
          vec4 column=cachedOnly?cachedColumn:pointColumn;
          if(!cachedOnly && useCached)column=mix(pointColumn,cachedColumn,smoothstep(900.0,2400.0,footprint));
          if(column.a<0.004) discard;
          gl_FragColor=column*uEngage;
          return;
        }
`;
  return result.slice(0, a) + dispatch + result.slice(b);
}
