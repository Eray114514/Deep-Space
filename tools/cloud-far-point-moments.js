// Exact Far point boundary. The original radial first moment and opacity are
// transported as FP32, then the physical source and air integral use that t.
export function farPointMomentShaders(source, densityOnly) {
  const start = '        float closest=-dot(uCameraLocal,dir);';
  const end = '        vec3 local=uCameraLocal+dir*t;\n        vec3 source=cloudCombinedSource(local,dir,0.0,uRout-uRin,0.0);';
  const declarations = '      uniform sampler2D tPointMoments;\n';
  const a = source.indexOf(start), b = source.indexOf(end);
  if (a < 0 || b <= a || densityOnly.split('return vec4(t,0.0,0.0,moment);').length !== 2)
    throw Error('Missing exact Far point moment boundary');
  return {
    moments:densityOnly.replace('return vec4(t,0.0,0.0,moment);','return vec4(t,moment,0.0,0.0);'),
    light:declarations+source.slice(0,a)+`        vec2 payload=texelFetch(tPointMoments,ivec2(gl_FragCoord.xy),0).rg;
        float t=payload.x,moment=payload.y;
        if(moment<0.004) return vec4(0.0);
`+source.slice(b),
  };
}
