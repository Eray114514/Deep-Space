# Repository Guidelines

## Project Structure & Module Organization

This is a browser-based, procedural Three.js game using native ES modules. Runtime code lives in `src/`: `main.js` owns the game state and render loop; world generation is split among `galaxy.js`, `planet.js`, `quadtree.js`, `noise.js`, and `rng.js`; interaction and HUD code live in `controls.js`, `ui.js`, `starmap.js`, `sysview.js`, and `walkdial.js`. `starmap.js` is the two-level navigation chart (galaxy level lists star systems only; picking one enters the system level rendered by `sysview.js`, which draws the real deterministic system — shader sun, per-type procedural planet textures, true ephemeris orbits); `walkdial.js` is the walk-mode survey watch (custom element, driven via `setState`). Keep deterministic generation changes close to their source module. `vendor/` contains browser-ready Three.js files; do not edit it unless intentionally updating vendored dependencies. Static models and other shipped assets belong in `assets/` (served at the URL root as `/assets/...`, which works identically in `npm run dev`, `dist/`, and Vercel — avoid `public/`, which Vercel treats specially and serves from the URL root). Development, validation, and capture scripts are in `tools/`; documentation images are in `docs/`.

## Canonical Universe Contract

The release universe is the curated `milky-way` galaxy with seed `NAVEMI-382`. `src/world-config.js` is the authored source for its identity, special destinations, and stable `galaxy ID / system ID / body ID` tuning. The deterministic generators remain the runtime source for the infinite galaxy; do not replace them with a finite baked universe or treat a save file as world content.

`worlds/milky-way.lock.json` is the human-readable compatibility snapshot. It records the complete home-system dossier, the authored black-hole destination, the 18 nearest systems, a 64-system neighborhood profile, home-planet terrain/sea/cloud/ring sentinels, generator versions, and a SHA-256 fingerprint. It intentionally does not serialize the entire infinite lattice, renderer objects, textures, or player state. Regenerate it only with `npm run world:lock` after intentional re-curation, never merely to make a failing test pass.

Treat seeded outputs and RNG namespaces as content APIs. In particular, changing `rng.js`, `noise.js`, `names.js`, `astronomy.js`, `planet.js`, `galaxy-layout.js`, seed suffixes, probability constants, or the number/order of existing RNG draws can rewrite the selected universe. Add optional content through a new independent namespace where possible. Keep planet adjustments in `world-config.js`; for example, moving a liquid surface must not reshape the underlying terrain stream.

`npm test` rebuilds and compares the canonical lock. If it drifts unintentionally, preserve the old output by fixing the generator change. If a rewrite is intentional, rerun static curation, fixed-camera captures, relevant browser playtests, and multiplayer/save migration review; then update the lock and document the compatibility break. Save games should persist canonical IDs plus player-owned state, not generated render data, so all peers can reconstruct the same world from the release contract.

## Build, Test, and Development Commands

- `npm install` installs the Node tooling and Playwright.
- `npm run dev` serves the game at `http://127.0.0.1:8000` with the development FPS marker.
- `npm test` parses every `src/*.js` module and verifies the version contract.
- `npm run test:terrain` runs procedural terrain and LOD checks.
- `npm run test:gameplay` runs gameplay checks; `npm run test:astronomy:browser` exercises astronomy in Chromium.
- `npm run build` runs `npm test`, then recreates the deployable `dist/` directory. Do not hand-edit `dist/`.
- `npm run shots` captures headless visual scenarios; first run `npx playwright install chromium`.
- `npm run world:lock` rewrites the canonical-universe snapshot after an approved re-curation.

## Coding Style & Naming Conventions

Use ES modules, two-space indentation, semicolons, and single quotes, matching existing files. Prefer `camelCase` for variables/functions, `PascalCase` for classes, and kebab-case filenames such as `foreground-pass.js`. Keep seeded behavior reproducible: derive variability from the supplied seed/RNG instead of `Math.random()`. Update `src/version.js`, `package.json`, and the `main.js?v=` value in `index.html` together when releasing.

## Testing Guidelines

Run `npm test` for every code change. Run the targeted terrain, gameplay, seam, touch, or screenshot command when your change affects that area. Tests are executable scripts in `tools/`, not a separate test directory; name new checks `*test.js` and keep assertions deterministic.

## Commit & Pull Request Guidelines

Use concise Conventional Commit-style subjects, e.g. `feat: add pulse recharge` or `fix: stabilize planetary flight horizon`. Keep commits focused. Pull requests should state the player-visible impact, identify affected systems, link any issue, and include screenshots or captures for visual/UI changes. Mention verification commands and avoid bundling unrelated working-tree changes.

## 渲染后端

项目使用 WebGL 2 作为唯一渲染后端。WebGPU 迁移曾进行实验但已退役，最后保留 WebGPU 代码的 git 节点为 `b746772`，后续如重启迁移可参考该节点代码。不要在代码或文档中引入 WebGPU/NodeMaterial/TSL 相关描述或实现。
