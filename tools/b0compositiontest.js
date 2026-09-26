// B0 historical failures are archived in docs/baselines/b0-2026-09-20.
// The live gate now requires the repaired producer + depth + composite chain
// to agree with those same analytic fixtures.
await import('./b5transporttest.js');
