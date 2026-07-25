# Third-party notices

## Original Soundtrack

The packaged score under `assets/audio/` (18 MP3 tracks, ~117 MB total) was
generated with **Suno AI** and is bundled for non-commercial use with this
project. The track catalogue and the in-game scene each track is bound to are
authored in `src/music.js` (see `TRACK_DEFS`).

| File | Title | Scene |
| --- | --- | --- |
| `deep-space-1.mp3` | 深空巡航 1 | Cruise pool (space / flyto / landing / takeoff / boarding) |
| `starfall-atrium.mp3` | Starfall Atrium · 深空巡航 2 | Cruise pool |
| `rift-passage.mp3` | 弦界航道 · 深空巡航 3 | Cruise pool |
| `stellar-transition.mp3` | 恒星跃迁 | Cruise pool |
| `interstellar-flight.mp3` | 星际飞行 | Cross-system warp transit (loop) |
| `starmap.mp3` | 星图 | Galaxy chart open (loop) |
| `black-hole.mp3` | 黑洞观测 | Black-hole vicinity (loop) |
| `ice-planet.mp3` | 冰封行星 | On-foot, ice planet (loop) |
| `toxic-planet.mp3` | 剧毒行星 | On-foot, toxic planet (loop) |
| `lava-planet.mp3` | 火山行星 | On-foot, lava planet (loop) |
| `lush-planet.mp3` | 繁茂行星 | On-foot, lush planet (loop) |
| `desert-planet.mp3` | 荒漠行星 | On-foot, desert planet (loop) |
| `barren-planet.mp3` | 荒芜行星 | On-foot, barren planet (loop) |
| `exotic-planet.mp3` | 异相行星 | On-foot, exotic planet (loop) |
| `alpine-summit.mp3` | 高山雪顶 | On-foot, habitable snow biome (loop) |
| `surface-combat.mp3` | 地表战斗 | Reserved (no scene yet) |
| `space-combat.mp3` | 太空战斗 | Reserved (no scene yet) |
| `space-race.mp3` | 太空竞速 | Reserved (no scene yet) |

Tracks are streamed lazily via HTML `<audio>` elements routed through the
shared `AudioContext` (provided by `FlightAudio`). The full soundtrack is never
fetched at load time; each track is requested on first cue and then cached by
the browser via the immutable `Cache-Control` header on `/assets/`.

**Fork / redistribution notice:** Suno AI's copyright position on generated
content is not settled. These tracks are NOT released under MIT. Anyone forking
or redistributing this repository must obtain their own authorization for
commercial use, or replace the tracks under `assets/audio/` with their own
royalty-free / CC0 audio. The game runs normally with the directory removed
(audio load failures are swallowed silently by `src/music.js`).

## Three.js

Vendored under `vendor/`. Copyright (c) 2010-2026 Three.js Authors. Distributed
under the MIT License.
