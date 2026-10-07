# Optional three-geospatial compatibility probe

This source reproduces the local reference experiment. It is not a game test,
production dependency, or accepted visual target. The lockfile fixes the actual
dependency versions; the probe deliberately replaces STBN with deterministic
synthetic jitter. Its current orbit view has atmosphere disabled.

From the repository root:

```powershell
node tools/b4takramcompat.js --prepare
npm ci --prefix test-results/references/takram-compat
node tools/b4takramcompat.js --build
node tools/b4takramcompat.js
```

Generated dependencies and bundle stay under ignored `test-results/`.
The sphere uses R=6,000 km, one 1–3 km cloud layer, and one 55-degree sun.
The pinned upstream's WGS84 camera-height scratch and perspective step scale
are overridden for that sphere. Shared weather, multiple stars, log depth,
HUD/post integration, joint B5 transport and lifecycle are not established.
