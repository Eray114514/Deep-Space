// Tool-only candidate: dynamic loop bounds retain the original 16-slot cap,
// blocker order, containment rule and 64-direction stellar quadrature.
function replaceOnce(source, from, to) {
  if (source.split(from).length !== 2) throw Error('Stellar blocker-loop anchor must occur once: ' + from);
  return source.replace(from, to);
}

function changeLoops(source, capacity, prefix) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let candidate = replaceOnce(source,
    `for(int i=0;i<${capacity};i++) {` + newline + `      if(i>=${prefix}uLocalOccluderCount) break;`,
    `for(int i=0;i<min(${prefix}uLocalOccluderCount,${capacity});i++) {`);
  candidate = replaceOnce(candidate,
    `for(int k=0;k<${capacity};k++) {` + newline + '        if(k>=count) break;',
    `for(int k=0;k<min(count,${capacity});k++) {`);
  return replaceOnce(candidate,
    `for(int i=0;i<${capacity};i++) {` + newline + '        if(i>=count) break;',
    `for(int i=0;i<min(count,${capacity});i++) {`);
}

export function stellarBlockerLoopCandidateSource(source) {
  if (source.split('export const MAX_STELLAR_OCCLUDERS = 16;').length !== 2)
    throw Error('Stellar blocker capacity must remain the original 16');
  return changeLoops(source, '${MAX_STELLAR_OCCLUDERS}', '');
}

export function stellarBlockerLoopNativeSource(source) {
  let candidate = source;
  for (const prefix of ['', 'air_']) {
    const signature = `float ${prefix}localStellarVisibility(`;
    if (candidate.split(signature).length !== 2) throw Error('Expected one native stellar visibility function: ' + prefix);
    const start = candidate.indexOf(signature), brace = candidate.indexOf('{', start);
    let end = brace + 1, depth = 1;
    while (depth && end < candidate.length) {
      const character = candidate[end++];
      if (character === '{') depth++;
      else if (character === '}') depth--;
    }
    if (depth) throw Error('Unterminated native stellar visibility function: ' + prefix);
    const body = changeLoops(candidate.slice(start, end), '16', prefix);
    candidate = candidate.slice(0, start) + body + candidate.slice(end);
  }
  return candidate;
}
