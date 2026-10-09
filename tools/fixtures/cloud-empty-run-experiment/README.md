# Withdrawn per-beam empty-run reuse

This experiment is not production code and has no accepted performance gain.
Apply `experiment.patch` only to a separate checkout at `ec966fa`; copy
`benchmark.js.txt` to `tools/cloudemptyintervaltest.js` there and run:

```powershell
node tools/cloudemptyintervaltest.js
```

The benchmark is the captured verifier, not an ongoing runtime option. Its
historical-control path had a missing null-location guard and aborted; do not
present that aborted run as an independent old-program comparison.

The default same-program comparison preserved native and copied HDR exactly.
262,144 independent safety-radius queries matched exactly; 71,715 reused an
empty radial run. But warm GPU timings did not establish a benefit, and some
reuse draws were slower. The four scalar state values persist through the beam
loop; fewer mask fetches do not prove a lower shader cost. Source and timing
evidence: `docs/baselines/foundation-air-cost-2026-10-09/empty-run-reuse.json`.

The patch adds no texture format or extra forecast snapshot. It preserves the
same physical integration nodes. Both runtime files were restored after this
experiment; it must not be applied over the current checkout.
