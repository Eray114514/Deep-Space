// Shared decomposition of the production Far main. All physical functions,
// common rays, depth clipping and internal early-zero conditions stay verbatim.
function replaceOnce(source, from, to) {
  if(source.split(from).length!==2)throw Error('One Far split anchor required: '+from.slice(0,90));
  return source.replace(from,to);
}
export function cloudFarSplitShaders(source) {
  const start='        #if PRODUCTION_CLOUD_MEDIUM && CLOUD_FAR_VIEW\n        {';
  const end='        #else\n\n        float seg = t1 - t0;';
  if(source.split(start).length!==2||source.split(end).length!==2)throw Error('Complete production Far dispatch required');
  const a=source.indexOf(start),b=source.indexOf(end,a);if(b<=a)throw Error('Far dispatch bounds');
  const replace=body=>source.slice(0,a)+`        #if PRODUCTION_CLOUD_MEDIUM && CLOUD_FAR_VIEW\n        {\n${body}\n        }\n`+source.slice(b);
  // The combine stage never reads these payloads outside their support.
  // Keep the decision after the shared ray derivatives and depth clipping.
  const point=replace(`          if(uColumnsReady>0.5 && rayCone*t0>2400.0)discard;
          gl_FragColor=cloudFarColumn(dir,t0,t1);
          return;`);
  const cached=replace(`          if(uColumnsReady<=0.5 || rayCone*t0<=900.0)discard;
          gl_FragColor=cloudCachedColumn(dir,t0,t1);
          return;`);
  const direct=expression=>replace(`          vec4 column=${expression};
          if(column.a<0.004)discard;
          gl_FragColor=column*uEngage;
          return;`);
  const pointDirect=direct('cloudFarColumn(dir,t0,t1)'),cachedDirect=direct('cloudCachedColumn(dir,t0,t1)');
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
  const combine=replaceOnce(replace(mixBody),'      void main() {',declarations+'      void main() {');
  return { point, cached, pointDirect, cachedDirect, combine, replace };
}
