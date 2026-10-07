# Rejected radial interval experiment

This is a reproducible experiment, **not production code or a passing optimization**.
The runtime continues to use band v5 / shape v10 and the original R16UI masks.

`experiment.patch` reconstructs the entire experimental worktree from `ebef3ed`,
including the then-current ownership fixes, RG16UI metadata, packed surface
consumer, Node checks and `tools/cloudintervalperftest.js`. It does not include
the subsequent baked-texture fix. The patch was checked against an isolated Git
index containing `ebef3ed`; never apply it over the current working checkout.

To investigate, use a separate checkout at `ebef3ed`, apply this patch and run:

```powershell
node tools/cloudintervaltest.js
node tools/b4bandboundstest.js
node tools/cloudintervalperftest.js
node tools/cloudintervalperftest.js --scan-only-control
node tools/cloudintervalperftest.js --reset-state-control
```

The indexed traversal preserved 393,216 independently scanned mask/interval
cells in Node. It added 256 KiB to the candidate texture and 512 KiB to each
packed species atlas at width 128, for each live or forecast snapshot.
The unchanged three-slot R8 transport target remained approximately 24 MiB.

Real RTX/ANGLE cloud integration did **not** pass reproducibility. On 45,966
occupied rays, indexed traversal changed 149 half-float components between its
first and subsequent draws; the maximum copied HDR difference was .003173828125.
The same-program indexed/scan comparison accumulated 1,043 differences. The
requested and actual GPU interval flag agreed. Resetting renderer state did not
resolve it, and direct native reads also found 149 repeat differences. Root cause
is still open; CPU exactness is not evidence of compiled integration equivalence.

The scan-only control passed eight interleaved draws: native and copied HDR
differences zero. It is a negative control, **not an index optimization PASS**.
The indexed measurements cannot justify a performance gain. No tolerance was
relaxed; the experiment and its additional allocations were removed from runtime.

Fixed reports and source epochs:
[foundation ownership evidence](../../../docs/baselines/foundation-ownership-2026-10-08/README.md).
Before adopting any replacement, establish stable native HDR and an independent
physical beam reference, then measure warm cost and dynamic support/deadlines.
