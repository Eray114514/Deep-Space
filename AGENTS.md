# Repository Guidelines

## Project Structure & Module Organization

This is a browser-based, procedural Three.js game using native ES modules. Runtime code lives in `src/`: `main.js` owns the game state and render loop; world generation is split among `galaxy.js`, `planet.js`, `quadtree.js`, `noise.js`, and `rng.js`; interaction and HUD code live in `controls.js`, `ui.js`, and `starmap.js`. Keep deterministic generation changes close to their source module. `vendor/` contains browser-ready Three.js files; do not edit it unless intentionally updating vendored dependencies. Static models and other shipped assets belong in `assets/` (served at the URL root as `/assets/...`, which works identically in `npm run dev`, `dist/`, and Vercel — avoid `public/`, which Vercel treats specially and serves from the URL root). Development, validation, and capture scripts are in `tools/`; documentation images are in `docs/`.

## Build, Test, and Development Commands

- `npm install` installs the Node tooling and Playwright.
- `npm run dev` serves the game at `http://127.0.0.1:8000` with the development FPS marker.
- `npm test` parses every `src/*.js` module and verifies the version contract.
- `npm run test:terrain` runs procedural terrain and LOD checks.
- `npm run test:gameplay` runs gameplay checks; `npm run test:astronomy:browser` exercises astronomy in Chromium.
- `npm run build` runs `npm test`, then recreates the deployable `dist/` directory. Do not hand-edit `dist/`.
- `npm run shots` captures headless visual scenarios; first run `npx playwright install chromium`.

## Coding Style & Naming Conventions

Use ES modules, two-space indentation, semicolons, and single quotes, matching existing files. Prefer `camelCase` for variables/functions, `PascalCase` for classes, and kebab-case filenames such as `foreground-pass.js`. Keep seeded behavior reproducible: derive variability from the supplied seed/RNG instead of `Math.random()`. Update `src/version.js`, `package.json`, and the `main.js?v=` value in `index.html` together when releasing.

## Testing Guidelines

Run `npm test` for every code change. Run the targeted terrain, gameplay, seam, touch, or screenshot command when your change affects that area. Tests are executable scripts in `tools/`, not a separate test directory; name new checks `*test.js` and keep assertions deterministic.

## Commit & Pull Request Guidelines

Use concise Conventional Commit-style subjects, e.g. `feat: add pulse recharge` or `fix: stabilize planetary flight horizon`. Keep commits focused. Pull requests should state the player-visible impact, identify affected systems, link any issue, and include screenshots or captures for visual/UI changes. Mention verification commands and avoid bundling unrelated working-tree changes.
