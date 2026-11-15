# HALCYON VII — Blender build

The player ship is modelled by script so every step is reproducible and reviewable.

```bash
# 1. model + bake + reflection probes  (Blender 5.x, needs an OptiX GPU for the bakes)
blender -b --factory-startup --python tools/blender/build_halcyon.py -- --export <abs-out-dir>
# 2. pack for the game
node tools/blender/pack-ship.mjs <out-dir>/halcyon.raw.glb assets/halcyon/halcyon.glb
cp <out-dir>/probe-*.hdr assets/halcyon/
```

Preview renders while modelling (Cycles, a few seconds per view):

```bash
blender -b --factory-startup --python tools/blender/build_halcyon.py -- --preview <abs-dir> --views front34,rear34,mid,hold,pilot
```

Back faces render magenta in previews: Cycles shades both sides, the game culls them.

| file | owns |
|---|---|
| `halcyon/design.py` | section tables and dimensions (keep `DIMS` in step with `src/halcyon/ship/ships/halcyon.js`) |
| `halcyon/loft.py` | parametric section loft with real panel seams and per-panel ids |
| `halcyon/exterior.py`, `exterior_detail.py` | hull, wings, nacelles, engines; gear, RCS, antennas, lettering |
| `halcyon/cockpit.py`, `interior.py` | flight deck; mid-deck, cargo hold, bulkheads, labels |
| `halcyon/bake.py`, `probe.py` | per-vertex irradiance / occlusion / wear; zone reflection panoramas |
| `halcyon/export.py`, `pack-ship.mjs` | node contract and GLB packing |

Everything is authored in game coordinates (−Z forward, +Y up, y = 0 the deck) and converted by `common.G`.
Vertex colour: R per-panel tint, G seam groove, B baked occlusion, A baked edge wear.
