// Candidate shader edits for frozen attribution only. Not imported by runtime.
export function applyOceanOpticsCandidate(shader, mode) {
  const replace = (from, to) => {
    if (!shader.fragmentShader.includes(from)) throw new Error(`Missing ocean candidate marker: ${from}`);
    shader.fragmentShader = shader.fragmentShader.replace(from, to);
  };
  if (mode === 'crest-foam') {
    if (shader.fragmentShader.includes('float crestHeight = smoothstep(0.0, 0.12,')) return;
    replace('float openWhitecap = smoothstep(0.025, 0.075, length(gWaterMacroSlope))',
      `// Positive elevated steep faces can entrain air; arbitrary slopes cannot.
          float crestHeight = smoothstep(0.0, 0.12,
            vWaveHeight / max(uOceanHeight, 0.25));
          vec2 foamPoreUv = oceanCapillary(vOceanRelative + localUp * vWaveHeight,
            vec2(uTime * 0.017, -uTime * 0.011));
          vec2 foamPore = texture2D(uDetailTex, foamPoreUv * 1.0).rg;
          float resolvedPores = smoothstep(0.46, 0.61, foamPore.x * 0.6 + foamPore.y * 0.4);
          float openWhitecap = crestHeight * resolvedPores
            * smoothstep(0.035, 0.11, length(gWaterMacroSlope))`);
  }
  if (mode === 'volume-no-facet-emission') {
    replace('totalEmissiveRadiance += mix(uDeepC, uShallowC, gWaterShallow)',
      'totalEmissiveRadiance += vec3(0.0) * mix(uDeepC, uShallowC, gWaterShallow)');
  }
}
