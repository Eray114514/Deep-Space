import { cloudFarSplitShaders as splitShaders } from '../src/cloud/cloud-far-split-shaders.js';

function replaceOnce(source, from, to) {
  if(source.split(from).length!==2)throw Error('One Far split anchor required: '+from.slice(0,90));
  return source.replace(from,to);
}
export function cloudFarSplitShaders(source) {
  const {point,cached,pointDirect,cachedDirect,combine,replace}=splitShaders(source);
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
  return {point,cached,pointDirect,cachedDirect,combine,wrongOver,coverage};
}
