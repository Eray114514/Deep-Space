# No Man's Sky in three.js — Requirements & Goals

This is the project's goal document, compiled from everything the owner has asked for
so far. Treat it as the source of truth for what the project is meant to do.
When reviewing code or planning work: check the implementation against every
requirement here, call out gaps honestly (including "technically done but doesn't
*feel* done" — see Quality Bar), and prefer improving weak areas over adding
unrequested features. Update the Status section and this doc when requirements are
added or met — but never delete or water down a requirement without the owner
saying so.

## 1. Core vision

Recreate the *experience* of No Man's Sky in the browser with three.js:

- A **universe-scale**, seamless, explorable space: fly from deep space to any
  star, approach any planet, land, walk, swim, take off again — no loading
  screens, no cuts.
- **Everything procedural and seeded.** No hand-made or downloaded assets.
  Every planet, plant, sky, and (future) station is generated from the seed, and
  the same seed always produces the same world down to the individual prop
  ("walk away and come back, the same rock is waiting").
- **Every world different.** Planet types, palettes, terrain, flora species and
  skies must vary enough that arriving somewhere new feels like discovery.
- The owner's benchmark comment when only scale was in place: *"Remember this
  project is called no man's sky in three js. Only thing matching so far is the
  size of the universe."* — i.e. scale alone is not the goal; the **feel** of
  NMS (alien worlds, lushness, atmosphere, wonder) is the goal.

## 2. Feature requirements

### 2.1 Universe & travel
- Seeded galaxy with many reachable star systems; warp and manual interstellar
  flight both work.
- Full state machine: space flight → fly-to → landing → walking → takeoff →
  warp, all seamless.
- Underwater: planets with seas are divable (walk the seabed).
- Camera-relative rendering so float precision holds from interstellar space
  down to boot level.

### 2.2 Terrain & LOD — "perfectly seamless"
- Owner's words: moving close to a planet and taking off must *"not show any
  sudden changes in terrain AT ALL. Perfectly seemless."*
- No hard LOD swaps, no popping, geomorphed transitions; verified by the seam
  test (pixel-static parked frames at many altitudes; zero unmorphed level
  changes during descent/landing/takeoff).
- Owner's correction to keep in mind: *"It is not as seemless as you are
  claiming"* — passing the counters is not enough; detail resolving into view
  must also be **perceptually** invisible (prefetch exists for this; keep
  pushing perceived seamlessness).

### 2.3 Atmosphere, clouds, lighting
- Volumetric raymarched clouds near planets (owner asked for them explicitly),
  consistent with the impostor cloud deck, cloud shadows, and transit fog —
  one coverage field drives all of them.
- Modern lighting techniques where three.js supports them (GTAO exists behind
  `?gtao=1`, needs tuning for the log depth buffer before default-on).
- Sky dome (horizon glow, zenith gradient, sun halo), day/night cycle, sunset
  scenes, star dimming in daylight, headlamp at night.

### 2.4 Flora — alien, lush, visible everywhere
- *"Really cool weird trees because these are alien and different worlds. What
  about lush grass? Plants?"*
- Every planet grows its **own species** (seeded grammar): weird trunks and
  canopies (orbs / mushroom caps / fronds / tentacles), shrubs, glowing pod
  plants, real multi-blade grass. Colors derive from the planet's palette with
  alien hue drift; pods glow their accent color at night.
- **No creatures. Ever.** (Owner: "no creatures".)
- **Visible at every distance** — owner's acceptance criterion: *"if this land
  is full of purple trees, it should also look like it has purple trees from
  any distance."* Concretely:
  - No vegetation growing in front of the player's eyes.
  - Near bubble (detailed props) must hand off invisibly to the far tier
    (proxy trees to ~4.5 km), which fades at its rim into canopy-tinted
    terrain, which carries the color all the way to orbit.
  - Tree density/scale at the handoff must match so the forest doesn't thin
    or pop at any boundary.
- **Professional, not bare-bones** — owner: the world looked *"all low poly
  and a bare bones demo, I now want it to look more professional."* Baked
  shading gradients (fake AO), root-to-tip grass gradients, field-soft grass
  normals, contrast between vegetation and ground. When unsure how something
  is done well, **research prior art on the internet** (owner explicitly asked
  for this — e.g. the beautiful three.js grass demos).

### 2.5 Sky backdrop
- Nebulae and the galaxy band must read as natural scenery, not artifacts.
  Owner's bug report to never regress: *"white halos all around in a circle"*
  (the band segments showing as blobs) and *"coloured spherical halos"*
  (radial-gradient nebulae). Cloudy/streaky generated textures, subtle
  opacity. They are camera-fixed like a real sky (light-years away) — that's
  intended; looking artificial is the bug.

### 2.6 Space stations — PENDING
- *"Space stations should be procedural generated and different from each
  other."*
- Seeded per system; genuinely varied topology (e.g. ring / spine / cross /
  cluster grammars), emissive windows/lights that bloom can pick up, visible
  from space near a planet. No two alike.

### 2.7 Biome-specific audio — PENDING
- Owner approved this idea. Synthesized WebAudio (no audio assets): per-biome
  surface ambience (wind through leaves on lush, dry wind on desert, bubbling
  on toxic, crystalline shimmer on ice, rumble near lava), space hum, muffled
  underwater. Respect autoplay policies (start on first gesture); mutable;
  disable-able for tests (`?audio=0`).

### 2.8 Controls & platforms
- Desktop: WASD walking, mouse look, scroll fly, click-to-travel, L to land,
  T to take off, jump.
- Touch/mobile: fully playable — drag look, pinch fly, tap-to-travel, virtual
  joystick, jump/takeoff buttons; verified by the touch test suite.
- Performance must stay reasonable on modest GPUs (`?quality=low` path,
  instancing everywhere, capped draw calls).

## 3. Quality bar (how the owner judges work)

1. **Perceptual truth beats metrics.** "The test passes" is not done if the
   eye still catches it. The owner tests by flying around and looking.
2. **Artifacts are bugs** even when they're by-design (see the halo report).
   If it reads wrong, it is wrong.
3. **Worlds must feel alive and varied** — lushness, color, atmosphere.
   "Bare-bones demo" is the failure mode to avoid.
4. Honest reporting: if something is only partially achieved, say so plainly
   (the owner notices overclaiming).

## 4. Engineering constraints & practices

- **Determinism**: generation is a pure function of the seed. Never let placement
  or species depend on camera path, draw order, or rng draw-order drift. The
  sanity suite enforces walk-stability and rebuild determinism — keep it green.
- **No assets**: geometry, textures, and (future) audio are all generated in
  code at runtime.
- **three.js**: currently vendored r170 (`vendor/three.module.js`); an upgrade
  to latest (r18x/WebGPU) is a future task — the owner expects modern renderer
  capabilities where they help.
- **Test suites** (all must stay green before a release):
  - `node tools/sanity.js` — node-side: terrain sanity, LOD consistency,
    geomorph settling, scatter/far-flora determinism, instance caps.
  - `npm run seamtest` — descent/landing/takeoff seam counters + pixel diffs.
  - `npm run shots` — ~24 fixed scenarios, screenshot + no page errors.
  - `npm run touchtest` — 13 mobile gesture checks.
  - Visual probes (`tools/_*probe*.mjs`) for flora/sky/approach — review the
    actual images, not just exit codes (SwiftShader headless with
    `--enable-unsafe-swiftshader`; the shader-validation console dump that
    mentions `isPerspectiveMatrix`/`VALIDATE_STATUS` for the *sky dome* was a
    real bug, now fixed — don't assume console errors are benign).
- **Versioning**: bump `src/version.js` + `package.json` on every pushed change
  that affects the app, so the owner can confirm which build they're looking at
  (shown bottom-left in the UI; stale caches lie).
- **Screenshot-verify changes in many different settings** (owner asked for
  breadth explicitly): multiple seeds, planet types, altitudes, times of day —
  `tools/explore.js`, `tools/_flora_probe.mjs`, `tools/_v20_probe.mjs`.
- Commit and push in small increments (the remote container can revert the
  working tree without warning; origin is the source of truth).

## 5. Status snapshot (v0.20.0, 2026-07-10)

Done and verified:
- Seeded universe, systems, warp/manual travel, land/walk/dive/takeoff.
- Quadtree cube-sphere terrain with geomorphed, seam-tested LOD + prefetch.
- Volumetric clouds unified with cloud shadows/impostors; GTAO experiment.
- Per-planet alien flora (two tree species, shrubs, glowing pods, real grass),
  near scatter bubble + far proxy tier to ~4.5 km + canopy-tinted terrain to
  orbit; meadow landing bias for demos.
- Sky dome fixed (its shader had never compiled); de-halofied nebulae/band.
- Touch controls; desktop controls; quality-low path.

Pending / next (in owner's priority order):
1. Procedural space stations (§2.6).
2. Biome-specific audio (§2.7).
3. Perceived-seamlessness polish on terrain detail resolve (§2.2).
4. GTAO tuning for log-depth, then consider default-on (§2.3).
5. three.js upgrade / WebGPU evaluation (§4).

Known cosmetic issues (logged, not blocking): faint parallel streaks over
horizon suns; moon landings can spawn in dense forest; ice plains featureless
up close.

## 6. Deep Space rebuild acceptance criteria (v0.21+)

These project-specific requirements override older prototype constraints such
as "no assets" where they conflict.

- The opening and every warp arrival frame a large planet as a dominant,
  oppressive-scale body while keeping the Asterion S-9 clearly readable.
- Main planets are world-scale procedural bodies, not shared texture spheres.
  Every seed/type owns its terrain, palette, relief, liquids, atmosphere,
  clouds, flora and surface scatter, and orbit/flight/walking sample the same
  deterministic world functions.
- Atmosphere has playable thickness: crossing the outer glow leads to a long
  high-altitude overlook, then an above-cloud phase, cloud transit and only
  later low flight. Speed management may compress travel time but must not
  visually teleport between these layers.
- Desktop flight is mouse-steered with no inverted vertical axis. W/S provide
  thrust/brake and RMB or Shift provides stable boost. Boost feedback comes
  from acceleration, engine emission, FOV, streaks and audio—not random camera
  jitter.
- Escape, pointer-lock loss and browser visibility changes pause safely.
  Returning to the game must reacquire input without freezing simulation.
- Warp is a visible directed flight with charge-up, spatial streaking/folding,
  a sustained high-speed middle and a deliberate planetary arrival reveal.
- The shipped presentation includes the detailed GLB ship, designed HUD and
  procedural WebAudio. Debug-looking controls must not dominate the playfield.
- Screenshot review is authoritative. Cloud columns, shell barcodes, mosaic
  clouds, obvious sphere curvature near the ground and flat repeated planet
  surfaces are release-blocking visual defects even if automated tests pass.
