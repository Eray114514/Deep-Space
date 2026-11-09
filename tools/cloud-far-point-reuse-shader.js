function replaceOnce(source, from, to) {
  if (source.split(from).length !== 2) throw Error('Expected one point reuse shader boundary');
  return source.replace(from,to);
}

// Modes use the same native program. A sampled ray writes raw FP32 optical
// depths and its geometry. The reconstruction always keeps the receiver's
// own opacity and representative distance, and falls back to the full beam.
export function farPointReuseShader(source) {
  const header = /* glsl */`
    layout(location=0) out vec4 pointColor;
    layout(location=1) out vec4 pointBeams;
    layout(location=2) out vec4 pointGeometry;
    uniform int uProbeMode,uProbeStride,uProbeIndividual;
    uniform float uProbeDistance,uProbeOpacity,uProbeSpread,uProbeSolarSpread;
    uniform sampler2D tProbeBeams,tProbeGeometry;

    int probeLight(ivec2 pixel,float t,float opacity,out vec4 depths) {
      depths=vec4(0);
      ivec2 limit=textureSize(tProbeGeometry,0)-1;
      ivec2 a=(pixel/uProbeStride)*uProbeStride;
      ivec2 b=min(a+ivec2(uProbeStride),(limit/uProbeStride)*uProbeStride);
      if(all(equal(a,pixel))) {
        depths=texelFetch(tProbeBeams,a,0);
        return texelFetch(tProbeGeometry,a,0).g>=0.004?15:0;
      }
      vec2 fraction=vec2(pixel-a)/float(uProbeStride);
      if(any(greaterThan(pixel,b)))return 0;
      vec4 low=vec4(1e6),high=vec4(-1e6);
      vec4 values[4];
      for(int i=0;i<4;i++) {
        ivec2 samplePixel=ivec2((i&1)==0?a.x:b.x,i<2?a.y:b.y);
        vec2 support=texelFetch(tProbeGeometry,samplePixel,0).rg;
        if(support.g<0.004 || abs(support.r-t)>uProbeDistance || abs(support.g-opacity)>uProbeOpacity)return 0;
        values[i]=texelFetch(tProbeBeams,samplePixel,0);
        low=min(low,values[i]);high=max(high,values[i]);
      }
      bvec4 agrees=lessThanEqual(high-low,vec4(uProbeSpread));
      if(uProbeSolarSpread>0.0) {
        vec2 transmissionSpread=exp(-low.xy)-exp(-high.xy);
        agrees.x=agrees.x||transmissionSpread.x<=uProbeSolarSpread;
        agrees.y=agrees.y||transmissionSpread.y<=uProbeSolarSpread;
      }
      if(uProbeIndividual==0 && !all(agrees))return 0;
      depths=mix(mix(values[0],values[1],fraction.x),mix(values[2],values[3],fraction.x),fraction.y);
      return (agrees.x?1:0)|(agrees.y?2:0)|(agrees.z?4:0)|(agrees.w?8:0);
    }
    int probeReuseMask=0;
  `;
  const loop = '        for(int path=0;path<uLightPathCount;path++) {';
  const vertical = '        cloudVerticalAbove=depths.z;cloudVerticalTotal=depths.z+depths.w;';
  const moment = '        float t=weightedDistance/max(moment,1e-9);';
  const dispatch = '          gl_FragColor=cloudFarColumn(dir,t0,t1);';
  let shader = replaceOnce(source, loop, `        if(uProbeMode>=2)
          probeReuseMask=probeLight(ivec2(gl_FragCoord.xy),pointGeometry.r,pointGeometry.g,depths);
        if(uProbeMode==3)return vec3(0);
        if(probeReuseMask!=15) {
`+loop+`
          if((probeReuseMask&(1<<path))!=0)continue;
          depths[path]=0.0;`);
  shader = replaceOnce(shader,vertical,`        }
        pointBeams=depths;
        if(uProbeMode==1)return vec3(0);
`+vertical);
  shader = replaceOnce(shader,moment,moment+'\n        pointGeometry=vec4(t,moment,0.0,0.0);');
  shader = replaceOnce(shader,'      void main() {',`      void main() {
        pointBeams=vec4(0);pointGeometry=vec4(0);`);
  shader = replaceOnce(shader,dispatch,`          if(uProbeMode==1) {
            ivec2 pixel=ivec2(gl_FragCoord.xy);
            if(any(notEqual(pixel%uProbeStride,ivec2(0))))discard;
          }
          pointColor=cloudFarColumn(dir,t0,t1);
          if(uProbeMode==3)pointColor=vec4(
            float(probeReuseMask&1),float((probeReuseMask>>1)&1),
            float((probeReuseMask>>2)&1),float((probeReuseMask>>3)&1));`);
  return header+shader.replaceAll('gl_FragColor','pointColor');
}
