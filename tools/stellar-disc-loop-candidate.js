// Tool-only, same-64-sample stellar quadrature candidate. No runtime import.
function replaceOnce(source, from, to) {
  if (source.split(from).length !== 2) throw Error('Stellar disc-loop source anchor must occur once: ' + from);
  return source.replace(from, to);
}

export function stellarDiscLoopCandidateSource(source) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let candidate = replaceOnce(source, '    uLocalStarCount: { value: 0 },',
    '    uLocalStarCount: { value: 0 },' + newline + '    uStellarDiscSamples: { value: 64 },');
  candidate = replaceOnce(candidate, '  uniform int uLocalStarCount, uLocalOccluderCount;',
    '  uniform int uLocalStarCount, uLocalOccluderCount;' + newline + '  uniform int uStellarDiscSamples;');
  return replaceOnce(candidate, 'for(int j=0;j<64;j++)', 'for(int j=0;j<uStellarDiscSamples;j++)');
}

// Complete native cloud fragments contain both local and namespaced air copies.
// Vertex source must be left unchanged by the caller. The original 64.0 sample
// placement and accumulation divisors stay literal and byte-identical.
export function stellarDiscLoopNativeSource(source) {
  if (source.split('for(int j=0;j<64;j++)').length !== 3)
    throw Error('Expected exactly two stellar quadrature loops in native cloud fragment');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let candidate = source;
  for (const prefix of ['', 'air_']) {
    const declaration = `uniform int ${prefix}uLocalStarCount, ${prefix}uLocalOccluderCount;`;
    candidate = replaceOnce(candidate, declaration, declaration + newline + `  uniform int ${prefix}uStellarDiscSamples;`);
    const start = candidate.indexOf(`float ${prefix}localStellarVisibility(`);
    if (start < 0) throw Error('Missing native stellar visibility function: ' + prefix);
    const brace = candidate.indexOf('{', start);
    let end = brace + 1, depth = 1;
    while (depth && end < candidate.length) {
      const character = candidate[end++];
      if (character === '{') depth++;
      else if (character === '}') depth--;
    }
    if (depth) throw Error('Unterminated native stellar visibility function: ' + prefix);
    const body = replaceOnce(candidate.slice(start, end), 'for(int j=0;j<64;j++)',
      `for(int j=0;j<${prefix}uStellarDiscSamples;j++)`);
    candidate = candidate.slice(0, start) + body + candidate.slice(end);
  }
  return candidate;
}
