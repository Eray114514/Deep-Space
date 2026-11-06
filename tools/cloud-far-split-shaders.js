// Tool-only decomposition of the production Far main. All physical functions,
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
  const point=replace('          gl_FragColor=cloudFarColumn(dir,t0,t1);\n          return;');
  const cached=replace('          gl_FragColor=cloudCachedColumn(dir,t0,t1);\n          return;');
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
  const wrongOver=replaceOnce(combine,
    '              column=mix(point,cached,smoothstep(900.0,2400.0,footprint));',
    `            {
              float w=smoothstep(900.0,2400.0,footprint);
              vec4 p=point*(1.0-w),c=cached*w;
              column=c+p*(1.0-c.a);
            }`);
  const coverage=replace(`          float footprint=rayCone*t0;
          float w=uColumnsReady>0.5?smoothstep(900.0,2400.0,footprint):0.0;
          gl_FragColor=vec4(w,footprint/10000.0,1.0,1.0);return;`);
  return {point,cached,combine,wrongOver,coverage};
}
