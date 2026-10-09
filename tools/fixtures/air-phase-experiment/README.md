# Withdrawn air phase and integer LUT experiment

This is not production code. Apply `experiment.patch` to a separate checkout
at `ec966fa`. Copy `airkerneltest.js.txt` and `cloudlightcostdiag.js.txt` to the
corresponding files in `tools/`, then run, strictly serially:

```powershell
node tools/airkerneltest.js
node tools/airkerneltest.js --same-kernel-control
node tools/b4airgaptest.js
node tools/b5transporttest.js --production
node tools/cloudlightcostdiag.js --air
```

The fixed historical B5 report is retained separately. The patch includes explicit
integer loads of the same four LUT texels and a per-fragment, direction-keyed
two-star phase cache. The sphere-mean multiple-scattering bake keeps the
generic `starScatter` API because it supplies arbitrary view and sun directions.
An earlier missing-caller attempt aborted and is not an accepted measurement.

The final primitive comparison preserved LUT and transmission exactly, within
the separately measured Float32 radiance roundoff budget. That is not full
player quality acceptance. The captured historical primitive verifier checks
the restored positive direction, not the intermediate inverse result; it does
not establish cache invalidation. The final checker in `tools/airkerneltest.js`
compares both directions across the grid and is stricter on this point.
Same-page current/old-air/current/old-air timing
did not establish a gain: current no-fallback p50 47.756 / 48.709 ms, old
47.314 / 47.508 ms. Both this phase cache and the integer-load change were
withdrawn. No per-fragment cache or altered LUT sampler remains in production.

Reports live in `docs/baselines/foundation-air-cost-2026-10-09/`.
`lut-only-cost.json` and `stellar-loop-no-gain.json` are earlier candidate
epochs, not this patch's measurements. The loop epoch has no complete retained
source patch; its timing is historical corroboration only, not a reproducible
acceptance baseline. Do not compare timings across pages as speedup ratios.
