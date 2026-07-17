# UI design QA

- Source visual truth:
  - `D:\Eray0\下载\星图_固定视角_可以放大缩小可以拖动.png`
  - `D:\Eray0\下载\飞船HUD.png`
  - `D:\Eray0\下载\下飞船.png`
  - `D:\Eray0\下载\星系预览- 星球_鼠标悬浮于星球.png`
  - `D:\Eray0\下载\星系预览.png`
- Browser/viewport: Codex in-app Browser, 1280 × 720 desktop viewport.
- Runtime states captured:
  - `screenshots/final-qa/hud.png`
  - `screenshots/final-qa/walk.png`
  - `screenshots/final-qa/galaxy-map.png`
  - `screenshots/final-qa/system-view.png`
  - `screenshots/final-qa/planet-focus.png`
  - `screenshots/final-qa/hero.png`
- Full-view comparison evidence: each source and its matching implementation capture was opened together in the same visual comparison input.
- Focused comparison evidence: label safe areas, HUD corner groups, system information panels, selected-body resources, footer commands, and the central targeting ring were checked against the supplied references.
- Interaction verification: hero start, galaxy-map entry, galaxy-to-system transition, body selection, selected-body details, map return path, and the reproducible on-foot state were exercised in the in-app browser.
- Console status: no application exceptions were observed; one non-fatal vendor shader loop-unroll warning remains.
- Static verification: `node --check` passed for every changed JavaScript file and `git diff --check` passed.

## Findings and fixes

- [P1 resolved] Hidden map labels were still displayed because the author `display:grid` rule overrode the browser's `[hidden]` rule. Added an explicit `.sm-map-label[hidden] { display:none; }` rule.
- [P1 resolved] System-body labels could render beneath the left system card or right resource card. Runtime label collision now includes visible information panels as hard blockers.
- [P2 resolved] The default system star was a flat unlit sphere. It now uses an animated procedural emissive surface and view-dependent corona.
- [P2 resolved] Dense galaxy labels obscured the fixed-view map. Landmark selection, spatial distribution, collision rejection, and viewport safe areas now match the sparse reference hierarchy.
- [P2 resolved] Flight HUD panels occupied too much of the world view. Power, hull, targeting, destination, and telemetry are now anchored to the perimeter with a sparse central reticle.
- [P3 remaining] Procedural celestial bodies do not reproduce the exact authored planet textures from the Starfield captures; this is scene-art variance rather than an overlap, hierarchy, or interaction defect.

## Comparison history

- Pass 1: galaxy labels piled up at the upper-left edge; system labels intersected data panels.
- Pass 2: upper-left pile-up fixed; one system label still clipped behind the left panel.
- Pass 3: all five target UI states rendered without visible text overlap or boundary overflow at 1280 × 720; star presentation was upgraded after source comparison.

final result: passed
