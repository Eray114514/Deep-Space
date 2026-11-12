// Shared decomposition of the production Far main. All physical functions,
// common rays, depth clipping and internal early-zero conditions stay verbatim,
// while dead stage kernels are pruned so FXC only translates what each stage executes.
function replaceOnce(source, from, to) {
  if(source.split(from).length!==2)throw Error('One Far split anchor required: '+from.slice(0,90));
  return source.replace(from,to);
}
function checkedCutBetween(source, startMarker, endMarker) {
  const i = source.indexOf(startMarker);
  const j = i >= 0 ? source.indexOf(endMarker, i) : -1;
  if (i < 0 || j <= i) throw Error('Far split prune boundary missing: ' + startMarker.slice(0, 60) + ' -> ' + endMarker.slice(0, 60));
  return source.slice(0, i) + source.slice(j);
}
function prunePointStage(source) {
  return checkedCutBetween(source, '      vec2 cloudColumnDistribution(', '      bool cloudUseKeyframeDepth=');
}
function buildPointRayStage(source) {
  let rayFn = checkedCutBetween(source, '      float hash12(vec2 p) {', '      vec4 cloudFarColumn(vec3 dir, float start, float end) {');
  const tailStart = rayFn.indexOf('        float t=weightedDistance/max(moment,1e-9);', rayFn.indexOf('vec4 cloudFarColumn('));
  const tailEnd = rayFn.indexOf('      void main() {', tailStart);
  if (tailStart < 0 || tailEnd <= tailStart) throw Error('Far split pointRay tail boundary missing');
  rayFn = rayFn.slice(0, tailStart) + '        return vec4(weightedDistance/max(moment,1e-9),moment,0.0,1.0);\n      }\n\n' + rayFn.slice(tailEnd);
  const body = `          if(uSplitRayCull>0.5 && uColumnsReady>0.5 && rayCone*t0>2400.0)discard;
          vec4 rayMoment=cloudFarColumn(dir,t0,t1);
          if(rayMoment.y<0.004)discard;
          gl_FragColor=rayMoment;
          return;`;
  const a = rayFn.indexOf('        #if PRODUCTION_CLOUD_MEDIUM && CLOUD_FAR_VIEW\n        {');
  const b = rayFn.indexOf('        #else\n\n        float seg = t1 - t0;', a);
  const full = rayFn.slice(0, a) + `        #if PRODUCTION_CLOUD_MEDIUM && CLOUD_FAR_VIEW\n        {\n${body}\n        }\n` + rayFn.slice(b);
  return replaceOnce(full, '      void main() {', '      uniform float uSplitRayCull;\n      void main() {');
}
function prunePointShadeStage(source) {
  let out = prunePointStage(source);
  const colStart = out.indexOf('      vec4 cloudFarColumn(vec3 dir, float start, float end) {');
  const colEnd = out.indexOf('      void main() {', colStart);
  if (colStart < 0 || colEnd <= colStart) throw Error('Far split pointShade boundary missing');
  const shadeFn = `      uniform sampler2D uSplitRay;
      vec4 cloudFarShade(vec3 dir) {
        vec2 rayMoment=texelFetch(uSplitRay,ivec2(gl_FragCoord.xy),0).xy;
        float moment=rayMoment.y;
        if(moment<0.004) return vec4(0.0);
        float t=rayMoment.x;
        cloudBeamLodScale=clamp(t/3200.0,1.0,24.0);
        vec3 local=uCameraLocal+dir*t;
        vec3 source=cloudCombinedSource(local,dir,0.0,uRout-uRin,0.0);
        vec2 air=air_sphereHits(uCameraLocal,air_uTopR,dir);
        vec3 light,transmission;
        airIntegrate(uCameraLocal,dir,max(0.0,air.x),min(t,air.y),light,transmission);
        return vec4((light+transmission*source*uTint)*moment,moment);
      }
`;
  return out.slice(0, colStart) + shadeFn + out.slice(colEnd);
}
function pruneCachedStage(source) {
  let out = checkedCutBetween(source, '  float cloudFootprint=0.0;', '      float hash12(vec2 p) {');
  out = checkedCutBetween(out, '  float cloudBeamIterations=0.0,', '      float cloudScatteringPhase(');
  out = checkedCutBetween(out, '      bool cloudUseKeyframeDepth=', '      void cloudAirTransport(');
  out = checkedCutBetween(out, '      vec4 cloudFarColumn(', '      void main() {');
  if (!out.includes('float cloudFootprint')) {
    out = replaceOnce(out, '      void main() {', '      float cloudFootprint=0.0;\n      void main() {');
  }
  return out;
}
function pruneCombineStage(source) {
  const limitEnd = '        return forwardDistance / forwardCos;\n      }\n';
  const i = source.indexOf(limitEnd), j = source.indexOf('      void main() {', i);
  if (i < 0 || j <= i) throw Error('Far split combine boundary missing');
  return source.slice(0, i + limitEnd.length) + '      float cloudFootprint=0.0;\n' + source.slice(j);
}
export function cloudFarSplitShaders(source, { splitPoint = false } = {}) {
  const start='        #if PRODUCTION_CLOUD_MEDIUM && CLOUD_FAR_VIEW\n        {';
  const end='        #else\n\n        float seg = t1 - t0;';
  if(source.split(start).length!==2||source.split(end).length!==2)throw Error('Complete production Far dispatch required');
  const a=source.indexOf(start),b=source.indexOf(end,a);if(b<=a)throw Error('Far dispatch bounds');
  const replace=body=>source.slice(0,a)+`        #if PRODUCTION_CLOUD_MEDIUM && CLOUD_FAR_VIEW\n        {\n${body}\n        }\n`+source.slice(b);
  const pointExpr = splitPoint ? 'cloudFarShade(dir)' : 'cloudFarColumn(dir,t0,t1)';
  const wrapPoint = splitPoint ? prunePointShadeStage : prunePointStage;
  const point=wrapPoint(replace(`          if(uColumnsReady>0.5 && rayCone*t0>2400.0)discard;
          gl_FragColor=${pointExpr};
          return;`));
  const cached=pruneCachedStage(replace(`          if(uColumnsReady<=0.5 || rayCone*t0<=900.0)discard;
          gl_FragColor=cloudCachedColumn(dir,t0,t1);
          return;`));
  const direct=expression=>replace(`          vec4 column=${expression};
          if(column.a<0.004)discard;
          gl_FragColor=column*uEngage;
          return;`);
  const pointDirect=wrapPoint(direct(pointExpr));
  const cachedDirect=pruneCachedStage(direct('cloudCachedColumn(dir,t0,t1)'));
  const declarations='      uniform sampler2D uSplitPoint,uSplitCached;\n';
  const mixBody=`          float footprint=rayCone*t0;
          ivec2 pixel=ivec2(gl_FragCoord.xy);
          vec4 point=texelFetch(uSplitPoint,pixel,0),cached=texelFetch(uSplitCached,pixel,0);
          vec4 column;
          if(uColumnsReady>0.5 && footprint>2400.0)column=cached;
          else {
            column=point;
            if(uColumnsReady>0.5 && footprint>900.0)
              column=mix(point,cached,smoothstep(900.0,2400.0,footprint));
          }
          if(column.a<0.004)discard;
          gl_FragColor=column*uEngage;
          return;`;
  const combine=replaceOnce(pruneCombineStage(replace(mixBody)),'      void main() {',declarations+'      void main() {');
  const pointRay = splitPoint ? buildPointRayStage(source) : null;
  return { point, cached, pointDirect, cachedDirect, combine, ...(pointRay ? { pointRay } : {}), replace };
}
