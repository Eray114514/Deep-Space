// All beams enabled is a numerical control for the two deliberately
// incomplete lighting arms. The masks are diagnostics, not quality modes.
export function farPointBeamShader(source) {
  const loop = '        for(int path=0;path<uLightPathCount;path++) {';
  if (source.split(loop).length !== 2) throw Error('Expected one physical light path loop');
  return 'uniform int uPointBeamMask;\n'+source.replace(loop,
    loop+'\n          if((uPointBeamMask&(1<<path))==0)continue;');
}
