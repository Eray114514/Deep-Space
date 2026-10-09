# Rejected single-occluder classification

This is not production code. In a separate checkout at `ec966fa`, apply
`experiment.patch`, copy `benchmark.js.txt` to `tools/stellarvisibilitytest.js`,
then run `node tools/stellarvisibilitytest.js` on hardware Chromium.

The candidate used conservative cosine tests to bypass the angular overlap
calculation for clear and contained small discs. No light path or cloud density
was changed. Dense native Float32 tests covered 1,310,720 points, including
contact strips and zero/tiny stellar radii. The exact old/new gate failed:
the zero-radius contact strip differed by 1; finite-disc cases differed by up
to 0.000011622905731201172. The precise shader/compiler cause is unresolved.

The failure report is
`docs/baselines/foundation-air-cost-2026-10-09/stellar-visibility-rejected.json`.
There is no accepted performance result. The runtime was restored; do not
apply this patch to the working checkout or weaken the gate to keep it.
