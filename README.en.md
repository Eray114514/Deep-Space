# 深空 · Deep Space

[简体中文](./README.md) | **English**

<p align="center">
  <a href="https://dp.eray.top"><img src=".github/hero.jpg" alt="深空 · Deep Space"></a>
</p>

<p align="center">
  <a href="https://dp.eray.top"><img src="https://img.shields.io/badge/▶_Play_now-dp.eray.top-7c3aed?style=for-the-badge" alt="Play now"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-3178c6?style=for-the-badge" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/WebGL_2-990000?style=for-the-badge&logo=webgl&logoColor=white" alt="WebGL 2">
  <img src="https://img.shields.io/badge/Three.js-black?style=for-the-badge&logo=threedotjs&logoColor=white" alt="Three.js">
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript">
  <img src="https://img.shields.io/badge/ESM-222?style=for-the-badge&logo=javascript&logoColor=f7df1e" alt="ES Modules">
  <img src="https://img.shields.io/badge/Vercel-000?style=for-the-badge&logo=vercel&logoColor=white" alt="Deployed on Vercel">
</p>

A fully procedural universe you can explore seamlessly in the browser. Roll from interstellar space down to any planet's surface and **set foot on any world** — oceans, rivers, ice caps, craters, dunes, lava seas, clouds, rings and moons, all generated from a seed. Leave and come back, the same rock is still there. Once you're down, you can walk into a frontier outpost, trade fire with patrol robots in the rain, or step off the ramp at cloud top and fly a canopy to the ground.

Built on native ES modules and Three.js. Runs directly during development and produces a self-contained static deployment to `dist/`. The render pipeline uses WebGL 2.

## Features

- **Curated galaxy**: a finite, deterministic barred-spiral galaxy of exactly **1,024 reachable star systems**, distributed across bulge / bar / main arms / short arms / spurs / disc / halo. Every star system — sun color, planet count, types, orbits, moons, naming — is deterministically generated from catalogue coordinates. Stars visible in the sky are anchored to these 1,024 catalogue points; background stars are a decorative layer jittered from catalogue anchors, with no fake skybox.
- **Eight terrestrial archetypes**: lush, ocean, desert, ice, volcanic, barren, toxic, anomalous. Each planet has its own terrain, palette, liquids, atmosphere, clouds, flora and surface scatter. Gas and ice giants cannot be landed on, but you can drive all the way into the storm deck — a pressure-critical autopilot pulls the ship back out.
- **A human frontier**: exactly **64 inhabited systems** are fixed inside the 1,024 — a core metropolis, orbital hubs, surface outposts, and an aerostat city above a remote gas giant. Sites are deterministic content records, not stacked baked geometry; the chart, a save and the live system all resolve the same coordinates.
- **Seamless scale**: a state machine runs space flight → in-cabin walking → landing → walking → skydiving → takeoff → warp, with no loading screens. The scroll wheel goes from orbit to treetop; speed adapts to altitude.
- **Terrain LOD**: a cubed-sphere quadtree, from the 6 root faces visible at system scale down to the ground beneath you (~3.6 m per vertex on the homeworld, 7.2 m on low quality), all evaluating the same pair of `height` / `colorAt` functions. Tile switches do geomorph — no terrain popping.
- **Volumetric clouds and atmosphere**: near-field clouds are a real 3D density field (weather-driven, ray-marched), shaded at distance by split beam/point proxies; the sky dome, day/night cycle, sunset, cloud shadows and haze are all driven by the same atmosphere and weather state.
- **Weather**: one shared weather field decides cloud cover, rainfall and ground wetness. Rain is lit camera-facing streaks with ground splashes; wetness changes albedo and roughness in real time and layers in puddles and raindrop ripples.
- **Alien flora**: each planet grows its own species (seeded grammar) — weird trunks, canopies, shrubs, glowing pods, multi-blade grass; near scatter bubbles to a ~4.5 km far proxy layer and on to orbital canopy terrain tinting, with no visible switch.
- **Interstellar travel**: two modes — warp (stellar jump, folding the trip into a direct arrival) and rift (a real portal: both sides of the opening are the same space, and you fly through manually); real flight, not teleport. The target star swells from a point of light into a sun, planets materialize frame by frame.
- **Black hole**: Sagittarius A\* exists as a destination under its own versioned RNG namespace (`compact-objects:v1`); the event horizon, photon ring and accretion disc are visible in space, without re-rolling any existing star system.
- **Galactic chart**: a full 3D navigation mode (`M` key) exposing the local stellar network, routes, filters, target analysis and a deterministic planet-system view.
- **Ship and interior**: the HALCYON VII, a 27.9 m × 21.6 m long-range exploration corvette — modelled and baked in Blender (per-vertex cavity occlusion and cabin irradiance) and assembled at runtime from `assets/halcyon/halcyon.glb`. It flies in the forward camera view, banking on turns with engine plumes burning by speed. Cockpit, corridor and hold are fully walkable and the rear ramp opens. A designed ship HUD carries power allocation, shields, altitude, pulse and damage feedback.
- **Ship and surface weapons**: pulse cannon array in space (left click); on foot you carry six modular weapons (PAC-9 LONGSHORE, KR-7 CARBINE, KR-7 VANTAGE, VESPER 9, M12 BREACHER, STRIX 9) sharing a first-person gloved rig with procedural optics, muzzles and underbarrels — aim, reload, switch, holster, and throw frag grenades.
- **Outposts and combat**: surface outposts carry industrial props, habitat furniture, shootable glass and explosive crates, patrolled by Hound/Gull robots that shoot back, with Colonist crew and a K9 unit on site. The combat HUD shows ammo, crosshair and hit feedback.
- **High-altitude skydiving**: hover at cloud top, leave the cabin, freefall, deploy manually and steer on the brake toggles — orbit to ramp to canopy without a single load.
- **Audio**: 42 scene-scored tracks (27 Lyria 3.5 + 15 classic, see license), lazily loaded per scene; weapon, rain and footstep SFX are procedural and routed through a shared `AudioContext`.
- **Cross-platform input**: desktop (mouse + keyboard) and touch (single-finger steer, pinch throttle, virtual stick, ring buttons) are both playable; mobile auto-loads lighter.
- **Quality presets**: Auto / Performance / Balanced / Ultra, judged by real frame rate rather than GPU model.

## Quick Start

```bash
npm install          # Install Node tooling and Playwright
npm run dev          # → http://127.0.0.1:8000 (with dev FPS marker)
```

Any static file server works. `npm run dev` injects a dev-only FPS readout; production builds omit it.

```bash
npm test               # Contract checks (pure Node, ~30 s: catalogue, civilization sites, render state machine, version)
npm run test:terrain   # Procedural terrain / LOD checks
npm run test:gameplay  # Gameplay checks
npm run test:smoke     # One headless Chromium boot (shaders, generation, rendering, input, pause UI, ~1 min)
npm run test:full      # Every browser suite: gameplay, pointer lock, star map, rift, astronomy, sysview, seam, touch, ship
npm run build          # npm test then recreate deployable dist/
```

Release builds always use the curated `MILKY-038` seed and `milky-way` galaxy (1,024 star systems). Seed overrides are a dev-only world-lab tool: after `npm run dev`, append `?worldlab=1&seed=ANYTHING` (optionally `&galaxy=milky-way`, `&system=0,0,0&body=planet-0`); other dev params include `&nolock=1` (no pointer lock), `&quality=low`, `&post=0`, `&vclouds=0`, `&renderlook=legacy`. Permanent curation belongs in `src/world-config.js`; keep procedural generators seed-pure.

Headless screenshots and scene validation:

```bash
npx playwright install chromium
npm run shots            # screenshots/ — filter with SEED=… SHOTS=01,05
node tools/ship-shots.js # ship beauty captures
node tools/sanity.js     # Quick node-side check: height stats, LOD consistency, tile build
```

## Controls

### Space flight

| Input | Action |
|---|---|
| **Mouse** | Point the nose (hold RMB to free-look in cockpit view) |
| **W / S · A / D** | Thrust / brake · strafe |
| **Scroll wheel** | Fine thrust — speed adapts to altitude, same wheel from orbit to treetop |
| **Left click** | Fire the pulse cannon array |
| **Right click / Shift** | Boost |
| **Space** | Pulse burst (hold to charge) |
| **L / Shift + L** | Auto-land when low enough / hold position here; rough terrain or above 420 m becomes a hover |
| **V** | Cockpit / chase view |
| **M / Tab** | Open the galactic chart |
| **H** | Camera mode (hide HUD) |
| **Esc** | Abort route / pause |

Desktop left click belongs exclusively to weapons; pick targets from the chart (`M`) or by tapping on touch. In space the ship flies directly in front of the camera — banking on turns, engines glowing by speed; it fades out once you're on foot.

### On foot / surface

| Input | Action |
|---|---|
| **WASD** | Walk (**Shift** run, **Space** jump, **C / Ctrl** crouch) |
| **Left / right click** | Fire / aim down sights |
| **1–6 / scroll** | Switch weapon |
| **R / G** | Reload / holster |
| **Q** | Frag grenade |
| **F** | Interact: ramp, board, take the pilot seat |
| **T** | Recall the ship |
| **M / H / Esc** | Chart / camera mode / release mouse or pause |

### Cabin and parked

| Input | Action |
|---|---|
| **WASD · Shift** | Move inside the cabin · sprint |
| **F** | Sit in the pilot seat / toggle the rear ramp |
| **Space / W** | Ignite and take off from the seat |
| **V** | Switch view |

**Skydiving from cloud top.** On a cloudy world, fly to cloud top and press **L** to hover (or choose "skydive from hover" in the pause menu). Press **F** to leave the seat, walk aft and press **F** to open the ramp, then step off. In freefall hold **W** to tuck into a dive and release to arch out. **Space / F** deploys the canopy, **A / D** pull the corresponding brake toggle to steer, **S** flares to slow down. An AAD reserves deployment height from descent rate.

### Touch (phone / tablet)

| Gesture | In space | On foot |
|---|---|---|
| **One-finger drag** | Look / steer | Look around |
| **Pinch** | Forward / back (touch throttle) | — |
| **Tap** | Select / fly to planet · tap a distant star to warp | — |
| **Two-finger drag** | Orbit the selected planet | — |
| **Virtual stick** | — | Walk · push to edge to run |
| **⤊ / 🚀 button** | — | Jump / take off |

Touch devices are auto-detected (`pointer: coarse`): the ring controls only appear while walking on a surface, and mobile render resolution is capped. In flight, tap **Ⅱ** for the travel menu to hover; use "stand up", "interact" and the stick to leave the cabin, push forward to dive, tap "deploy" for the canopy, steer with the brakes, pull back to slow down.

## Technical Architecture

### Consistency: every planet is a pair of pure functions

Each planet is defined as two pure functions (seed-derived) over the unit direction on its sphere:

```
height(dir, maxFreq)      -> terrain elevation (metres)
colorAt(dir, h, slope, maxFreq) -> surface color
```

Every sampling builds on the same pair:

- **Terrain LOD** (`src/quadtree.js`): a cubed-sphere quadtree; each tile, from a root face down to the ground beneath you, evaluates `height` / `colorAt` on its own grid. `maxFreq` caps noise octaves to the tile's own sampling rate (the first octave of each landform is always kept, so mean elevation and silhouette never jump between LODs). A planet at any distance is literally the same function. LOD switches do geomorph: each tile carries its parent-resolution shape, normals and color as a relative morph target, splitting into the exact parent shape and relaxing to detail (merges animate in reverse) — no terrain popping.
- **Walking** (`src/controls.js`): the ground underfoot is `height(dir)`, not a mesh raycast, so you stand exactly on the terrain you saw from orbit.
- **Liquids**: sea, ice cap and lava are spheres at a seeded sea level; rivers are channels the `height` function carves below sea level, so they flood themselves.
- **Scatter** (`src/scatter.js`): trees / rocks / crystals are placed by hashing the planet's fixed surface cells — leave and return, the same rock is still there.

### Planet-scale floating-point precision

Uses camera-relative rendering: positions live in float64 universe coordinates, the camera stays at the scene origin, and the world repositions around it each frame (plus a logarithmic depth buffer). Tile-local vertex origins and float64 universe coordinates still keep millimetre precision at these scales.

### Scale

Terrestrial planet radii **160–400 km** (the homeworld is authored at 1,200 km); gas/ice giants 620–1,700 km, moons 28–150 km. Planet orbit render radii start at **60,000 km** and step out by 1.68× per body to 1,600,000 km; star systems sit on a **4×10⁶ km** catalogue lattice. Large enough that dropping from orbit and trekking across a planet feels planetary, yet compressed so interplanetary flight takes minutes and warps cross in seconds.

## Project Structure

| Path | Responsibility |
|---|---|
| `src/main.js` | Game state machine and render loop, camera-relative rendering, ambience and input wiring |
| `src/rng.js` | Seed hashing + PRNG — the root of all determinism |
| `src/noise.js` | Seeded simplex, fBm / ridged / billow / worley |
| `src/planet.js` | Planet archetypes, `height` & `colorAt`, palettes, water/lava/ice, atmosphere, clouds, rings |
| `src/quadtree.js` | Tile cubed-sphere LOD with skirts, horizon culling and build budget |
| `src/astronomy.js` / `src/galaxy.js` / `src/galaxy-layout.js` | Ephemerides and body specs, universe lattice, suns, starfield, nebulae |
| `src/sysview.js` / `src/starmap.js` | System view and two-level galactic chart |
| `src/black-hole.js` | Sagittarius A\* event horizon, photon ring and accretion disc |
| `src/portal/` / `src/warp-conduit.js` | Rift portal (geometry, mapped view, per-pixel composite) and warp conduit |
| `src/civilization.js` / `src/artificial-sites.js` | Content records for the 64 inhabited systems, and artificial-site instantiation |
| `src/scatter.js` / `src/flora.js` / `src/farflora.js` / `src/vegetation/` | Surface scatter, alien flora near/far layers, tree species and disturbance |
| `src/cloud/` / `src/clouds.js` / `src/volumetric-pass.js` | Volumetric cloud implementation, cloud species, weather field |
| `src/weather/` / `src/weather-effects.js` | Rain, wet ground and weather presentation |
| `src/controls.js` / `src/walkdial.js` / `src/skydive.js` / `src/skydive-rig.js` | Flight and spherical-gravity first-person walking, survey dial, skydiving and canopy rig |
| `src/effects.js` / `src/ship-hud.js` | Ship and pulse cannon, ship HUD |
| `src/ship-view.js` / `src/halcyon/` | Cabin walking, rear ramp, GLB assembly, interior irradiance and ship audio |
| `src/surface-weapons.js` / `src/weapons/` | Six surface weapons, first-person gloved rig, procedural weapon geometry and weapon SFX |
| `src/surface/` | Outpost and habitat props, destructibles, robots, colonists and K9, surface gameplay coordinator |
| `src/music.js` / `src/audio.js` / `src/audio/` | Score catalogue, flight audio and procedural SFX |
| `src/world-config.js` | Authored source of the curated universe's identity, special destinations and stable tuning |
| `src/renderer-runtime.js` / `src/renderer-policy.js` | WebGL 2 render runtime and policy |
| `tools/blender/` | Blender build and GLB packing scripts for the HALCYON VII |
| `vendor/` | Browser-ready Three.js files; do not edit unless intentionally upgrading the vendored dependency |
| `assets/` | Static models (`halcyon/halcyon.glb` included), textures and audio, served at `/assets/...` from the URL root |
| `tools/` | Dev, validation, performance and screenshot scripts |
| `THIRD_PARTY_NOTICES.md` | Third-party asset provenance and licences: soundtrack, Three.js |
| `worlds/milky-way.lock.json` | Canonical-universe compatibility snapshot (see below) |

## Canonical Universe Contract

The release universe is the curated `milky-way` galaxy with seed `MILKY-038` and a fixed catalogue of exactly 1,024 reachable star systems. `src/world-config.js` is the authored source for its identity, special destinations and stable `galaxy ID / system ID / body ID` tuning; `src/galaxy-layout.js` is the runtime source for those 1,024 catalogue systems (`buildGalaxyCatalog` enforces `systemCount === 1024`). Do not replace them with another finite baked catalogue or treat a save file as world content. The 64 inhabited systems are likewise deterministic content records (`src/civilization.js`); the chart, system view and live game resolve the same sites.

`worlds/milky-way.lock.json` is the human-readable compatibility snapshot. It records the complete home-system dossier, the authored black-hole destination, the 18 nearest systems, a 64-system neighbourhood profile, the 64 civilization sites, home-planet terrain/sea/cloud/ring sentinels, generator versions and a SHA-256 fingerprint. It intentionally does not serialize whole-planet render objects, textures or player state (planetary surfaces are still procedurally generated on demand). Regenerate it only with `npm run world:lock` after intentional re-curation, never merely to make a failing test pass.

Treat seeded outputs and RNG namespaces as content APIs. In particular, changing `rng.js`, `noise.js`, `names.js`, `astronomy.js`, `planet.js`, `galaxy-layout.js`, seed suffixes, probability constants, or the number/order of existing RNG draws can rewrite the selected universe. Add optional content through a new independent namespace where possible. Keep planet adjustments in `world-config.js`.

## License

This project's code is released under the **MIT License**.

### Third-party and exceptions

- **Soundtrack** (42 MP3s under `assets/audio/`, ~250 MB): 27 tracks generated with **Google DeepMind Lyria 3.5** (via Google Flow Music) and 15 earlier **Suno AI** tracks. The copyright status of AI-generated music varies by jurisdiction and service terms; these tracks are **not** released under the MIT license and are distributed with this project for **non-commercial** use only. The full track table and scene bindings are in `THIRD_PARTY_NOTICES.md` and `src/music.js`. **Forkers note**: obtain your own authorisation before distributing or commercial use, or replace them with your own / CC0 tracks; the game still runs after removing the `assets/audio/` directory (audio load failures are silently handled).
- **Three.js**: vendored under `vendor/`, under its MIT license.
