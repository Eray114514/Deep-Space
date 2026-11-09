// Experimental split at the exact near transport boundary. The sixteen
// optical-depth quantiles and opacity are stored without half-float rounding.
export function cloudNearSplitShaders(source) {
  const begin = '        float anchors[32];';
  const shade = '        vec3 correction=vec3(0);';
  const end = '        gl_FragColor = vec4(correction * uEngage, alpha);\n        #else';
  const [a,b,c] = [begin,shade,end].map(text => {
    if (source.split(text).length !== 2) throw Error(`Unexpected near shader boundary ${text}`);
    return source.indexOf(text);
  });
  if (!(a < b && b < c)) throw Error('Unexpected near transport order');
  const tail = c+end.indexOf('\n');
  const names = ['tNearAnchor0','tNearAnchor1','tNearAnchor2','tNearAnchor3','tNearOpacity'];
  const outputs = names.map((_,index) => `layout(location=${index}) out vec4 nearOutput${index};`).join('\n');
  const stores = names.slice(0,4).map((_,index) => {
    const channels = Array.from({length:4},(_,channel)=>`anchors[${4*index+channel}]`).join(',');
    return `          nearOutput${index}=vec4(${channels});`;
  }).join('\n');
  const density = (outputs+'\n'+source.slice(0,b)+stores+'\n          nearOutput4=vec4(totalOpacity,0,0,0);'+source.slice(tail))
    .replaceAll('gl_FragColor','nearOutput0');
  const loads = names.slice(0,4).map((name,index)=>`          vec4 nearAnchors${index}=texelFetch(${name},pixel,0);`).join('\n');
  const transport = source.slice(b,tail).replace('float distance=anchors[bin];',
    `float distance=bin<4?nearAnchors0[bin]:bin<8?nearAnchors1[bin-4]:bin<12?nearAnchors2[bin-8]:nearAnchors3[bin-12];`);
  if (transport.includes('anchors[bin]')) throw Error('Untransformed near anchor read');
  const light = `uniform sampler2D ${names.join(',')};\n`+source.slice(0,a)+`
          ivec2 pixel=ivec2(gl_FragCoord.xy);
          float totalOpacity=texelFetch(tNearOpacity,pixel,0).r;
          float alpha=totalOpacity*uEngage;
          if(alpha<0.004)discard;
          int bins=clamp(uLightQuadratureSteps,4,32);
${loads}
`+transport+source.slice(tail);
  return { density,light,names };
}
