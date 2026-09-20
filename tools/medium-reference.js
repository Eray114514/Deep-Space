// B0 reference only; not a production renderer. Metres, inverse metres and
// linear RGB source radiance per metre. Constant overlapping slabs have an
// analytic solution; source terms are prescribed (no multiple-scattering solver).
// https://pbr-book.org/4ed/Light_Transport_II_Volume_Rendering/The_Equation_of_Transfer
export function integrateMediumSlabs(slabs, depth, background = [0, 0, 0]) {
  const cuts = [...new Set([0, depth, ...slabs.flatMap((s) => [s.start, s.end])])]
    .filter((t) => t >= 0 && t <= depth).sort((a, b) => a - b);
  const L = [0, 0, 0], T = [1, 1, 1];
  for (let i = 1; i < cuts.length; i++) {
    const length = cuts[i] - cuts[i - 1];
    const mid = (cuts[i] + cuts[i - 1]) / 2;
    const active = slabs.filter((s) => mid >= s.start && mid < s.end);
    for (let c = 0; c < 3; c++) {
      const sigma = active.reduce((sum, s) => sum + s.extinction[c], 0);
      const source = active.reduce((sum, s) => sum + s.source[c], 0);
      const segmentT = Math.exp(-sigma * length);
      const segmentL = sigma > 0 ? source * -Math.expm1(-sigma * length) / sigma : source * length;
      L[c] += T[c] * segmentL;
      T[c] *= segmentT;
    }
  }
  return { L, T, radiance: L.map((l, c) => l + T[c] * background[c]) };
}

const air = { kind: 'air', start: 0, end: 30000,
  extinction: [0.000012, 0.000025, 0.00005], source: [0.000008, 0.000016, 0.00003] };
const cloud = (start, end, sigma) => ({ kind: 'cloud', start, end,
  extinction: [sigma, sigma, sigma], source: [0.85, 0.82, 0.78].map((v) => v * sigma) });
const background = [0.18, 0.24, 0.13];
export const MEDIUM_FIXTURES = [
  { name: 'clear-air', slabs: [air], depth: 30000, background, expectLegacyGap: false },
  { name: 'cloud-without-air', slabs: [cloud(4000, 7000, 0.0004)], depth: 30000, background, expectLegacyGap: false },
  { name: 'single-cloud', slabs: [air, cloud(4000, 7000, 0.0004)], depth: 30000, background, expectLegacyGap: true },
  { name: 'thin-layer', slabs: [air, cloud(12000, 12400, 0.0004)], depth: 30000, background, expectLegacyGap: true },
  { name: 'thick-cloud', slabs: [air, cloud(6000, 18000, 0.001)], depth: 30000, background, expectLegacyGap: true },
  { name: 'inside-cloud', slabs: [air, cloud(-2000, 7000, 0.0008)], depth: 30000, background, expectLegacyGap: true },
  { name: 'opaque-before-cloud', slabs: [air, cloud(6000, 18000, 0.001)], depth: 3000, background, expectLegacyGap: false },
  { name: 'opaque-inside-cloud', slabs: [air, cloud(6000, 18000, 0.001)], depth: 9000, background, expectLegacyGap: true },
];
