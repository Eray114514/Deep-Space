// Diagnostic source transform only. This candidate fixes the shared-uniform /
// separate-define mismatch, but its full physical far shader missed readiness
// deadlines. Keep it outside runtime until native availability is resolved.
export function cloudOcclusionCandidateSource(source) {
  const anchor = 'for (const material of [this.volCloudMat, this.terrainMaterial, this.liquidMat]) {';
  if (source.split(anchor).length !== 2) throw Error('Expected the original cloud topology binding exactly once');
  return source.replace(anchor, 'for (const material of [this.volCloudMat, this.volCloudFarMat, this.terrainMaterial, this.liquidMat]) {');
}
