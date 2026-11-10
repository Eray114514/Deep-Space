# Repository Guidelines

## Project Structure & Module Organization

This is a browser-based, procedural Three.js game using native ES modules. Runtime code lives in `src/`: `main.js` owns the game state and render loop; world generation is split among `galaxy.js`, `planet.js`, `quadtree.js`, `noise.js`, and `rng.js`; interaction and HUD code live in `controls.js`, `ui.js`, `starmap.js`, `sysview.js`, and `walkdial.js`. `starmap.js` is the two-level navigation chart (galaxy level lists star systems only; picking one enters the system level rendered by `sysview.js`, which draws the real deterministic system — shader sun, per-type procedural planet textures, true ephemeris orbits); `walkdial.js` is the walk-mode survey watch (custom element, driven via `setState`). Keep deterministic generation changes close to their source module. `vendor/` contains browser-ready Three.js files; do not edit it unless intentionally updating vendored dependencies. Static models and other shipped assets belong in `assets/` (served at the URL root as `/assets/...`, which works identically in `npm run dev`, `dist/`, and Vercel — avoid `public/`, which Vercel treats specially and serves from the URL root). Development, validation, and capture scripts are in `tools/`; documentation images are in `docs/`.

## Canonical Universe Contract

The release universe is the curated `milky-way` galaxy with seed `MILKY-038` and a fixed catalogue of exactly 1,024 reachable star systems. `src/world-config.js` is the authored source for its identity, special destinations, and stable `galaxy ID / system ID / body ID` tuning; `src/galaxy-layout.js` (`buildGalaxyCatalog`, which throws if `systemCount !== 1024`) is the runtime source for those 1,024 catalogue systems. Do not replace them with another finite baked universe or treat a save file as world content.

`worlds/milky-way.lock.json` is the human-readable compatibility snapshot. It records the complete home-system dossier, the authored black-hole destination, the 18 nearest systems, a 64-system neighborhood profile, home-planet terrain/sea/cloud/ring sentinels, generator versions, and a SHA-256 fingerprint. It intentionally does not serialize renderer objects, textures, or player state (planetary surfaces are still procedurally generated on demand). Regenerate it only with `npm run world:lock` after intentional re-curation, never merely to make a failing test pass.

Treat seeded outputs and RNG namespaces as content APIs. In particular, changing `rng.js`, `noise.js`, `names.js`, `astronomy.js`, `planet.js`, `galaxy-layout.js`, seed suffixes, probability constants, or the number/order of existing RNG draws can rewrite the selected universe. Add optional content through a new independent namespace where possible. Keep planet adjustments in `world-config.js`; for example, moving a liquid surface must not reshape the underlying terrain stream.

`npm test` rebuilds and compares the canonical lock. If it drifts unintentionally, preserve the old output by fixing the generator change. If a rewrite is intentional, rerun static curation, fixed-camera captures, relevant browser playtests, and multiplayer/save migration review; then update the lock and document the compatibility break. Save games should persist canonical IDs plus player-owned state, not generated render data, so all peers can reconstruct the same world from the release contract.

## Build, Test, and Development Commands

- `npm install` installs the Node tooling and Playwright.
- `npm run dev` serves the game at `http://127.0.0.1:8000` with the development FPS marker.
- `npm test` parses every `src/*.js` module and verifies the version contract (fast, pure Node, ~3 s).
- `npm run test:smoke` boots the game once in headless Chromium and checks the paths most likely to break in a large change: shader/runtime errors, galaxy+planet generation, render pipeline, flight input, pause UI (~1 min).
- `npm run test:full` runs every focused browser suite (gameplay, pointer lock, star map, rift, astronomy, sysview, seam, touch) — the thorough pre-PR/verification layer.
- `npm run test:terrain` runs procedural terrain and LOD checks.
- `npm run test:gameplay` runs gameplay checks; `npm run test:astronomy:browser` exercises astronomy in Chromium.
- `npm run build` runs `npm test`, then recreates the deployable `dist/` directory. Do not hand-edit `dist/`.
- `npm run shots` captures headless visual scenarios; first run `npx playwright install chromium`.
- `npm run world:lock` rewrites the canonical-universe snapshot after an approved re-curation.

## Coding Style & Naming Conventions

Use ES modules, two-space indentation, semicolons, and single quotes, matching existing files. Prefer `camelCase` for variables/functions, `PascalCase` for classes, and kebab-case filenames such as `foreground-pass.js`. Keep seeded behavior reproducible: derive variability from the supplied seed/RNG instead of `Math.random()`. Update `src/version.js`, `package.json`, and the `main.js?v=` value in `index.html` together when releasing.

## Testing Guidelines

Tests are layered by cost. For every code change run `npm test` (pure-Node contract checks, ~3 s). After a large change run `npm run test:smoke` (one browser boot, ~1 min) to catch the regressions Node tests cannot see (render, shader, input, UI). Before a PR or release run `npm run test:full` (every focused browser suite) plus the targeted terrain, gameplay, seam, touch, or screenshot command for the area you touched. Tests are executable scripts in `tools/`, not a separate test directory; name new checks `*test.js` and keep assertions deterministic. Prefer sharing a single booted page across assertions (see `tools/browsertest.js`) over launching a fresh Chromium per check.

## Commit & Pull Request Guidelines

Use concise Conventional Commit-style subjects, e.g. `feat: add pulse recharge` or `fix: stabilize planetary flight horizon`. Keep commits focused. Pull requests should state the player-visible impact, identify affected systems, link any issue, and include screenshots or captures for visual/UI changes. Mention verification commands and avoid bundling unrelated working-tree changes.

涉及优化任务范围、难度或验收状态的变化，应在同一轮交付中同步更新 `docs/remaining-work-difficulty.md`。该文档只列待办，整项验收后删除条目，部分验收后只留余项。完成记录归原路线图和证据目录。

## 渲染后端

**[2026-08-15 用户决策] WebGL 2 是唯一画质与架构基准。** 运行时材质、体积效果和
后处理以 `legacy-render-pipeline.js` + 各 `*-webgl.js` GLSL 链为基准；`auto` 与
`?renderer=webgpu` 都解析到 WebGL2（见 `renderer-policy.js`）。新增视觉实现直接写
GLSL `ShaderMaterial` / `onBeforeCompile`，对齐老版（51c7c11 时代）的云/大气/水体
观感契约。

WebGPU/TSL 线已从工作树删除（同日决策）：`*-node.js`/TSL 模块、`node-render-pipeline.js`、
`three.webgpu.js`/`three.tsl.js` vendor 文件及相关实验页与测试均已移除，最后状态留档
于 git 历史。地表/远景植被随 WebGL 基准恢复（`scatter.js` / `farflora.js`，经典
InstancedMesh 链）。停牌原因见 `docs/optimization-roadmap.md` 2026-08-15 决策记录
（轨道体积云被 engage 门控关闭、大气闪烁、深度/合成所有权错误未能收敛）。重启条件：
TSL/NodeMaterial 生态成熟且出现 WebGL 无法承载的需求时，由用户重新决策（从 git
历史恢复），届时一次只迁一个子系统。

用户明确要求在当前任务调用 Claude 协作时，才读取并应用 [模型协作约定](docs/model-collaboration.md)。

* 项目正在进行全量重构，暂时不需要考虑宇宙锁（详情参考docs/optimization-roadmap.md）。确认重构完成后按用户要求进行重筛选，然后删除此注释。此前的任何任务都不需要考虑宇宙锁。
