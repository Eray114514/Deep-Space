# Rejected minimum-radius pruning

This experiment is not production code. Apply `experiment.patch` only to a
separate checkout at `ec966fa`, copy `benchmark.js.txt` to
`tools/cloudemptyintervaltest.js` there and run:

```powershell
node tools/cloudemptyintervaltest.js --historical-control
```

It evaluates the angular/shell bound before scanning radial bins. A bound below
the physical step cannot permit a jump, so the expensive radial search appears
unnecessary. No texture format, light distance or quadrature node was changed.

The actual lowflight native/copy HDR comparison against the independent old
program matched exactly, including repeated and reversed draws. But the
262,144-query safety-radius check differed by up to 0.4951171875 metres, and
warm timing did not establish a stable gain. The cause of that radius difference
was not resolved. The original zero-difference gate failed; it was not relaxed.

`docs/baselines/foundation-air-cost-2026-10-09/radius-pruning-rejected.json`
contains the failed report. Both runtime files were restored. The snapshot
benchmark depends on this patch and is deliberately outside executable tools.
Do not apply it over the current checkout or inherit its local HDR success as
an acceptance of the failed safety-radius check.
