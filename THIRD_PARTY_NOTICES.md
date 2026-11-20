# Third-party notices

## Original Soundtrack

The packaged score under `assets/audio/` (42 MP3 tracks, ~250 MB total) combines
27 original instrumental tracks generated with **Google DeepMind Lyria 3.5**
(via Google Flow Music, mastered from 48 kHz WAV to 256 kbps MP3) and 15 curated
tracks generated with **Suno AI**, bundled for non-commercial use with this
project. The in-game scene bindings are documented in `src/music.js`
(see `TRACK_DEFS`); the generator prompts live with the project's production
notes, which are not part of this repository.

| File | Generator | Title | Scene / Pool |
| --- | --- | --- | --- |
| `hero-theme.mp3` | Lyria 3.5 | 主菜单序曲 · 深空远征 | Hero title screen & launch pull-back (`hero`) |
| `starmap.mp3` | Lyria 3.5 | 银河星图 · 测绘静域 | Star map & route confirmation pool (`starmap`) |
| `starmap-classic.mp3` | Suno AI | 星图（经典版） | Star map & route confirmation pool (`starmap`) |
| `deep-space-1.mp3` | Lyria 3.5 | 深空巡航 I · 银盘微光 | Deep space cruise pool (`cruise`) |
| `deep-space-1-classic.mp3` | Suno AI | 深空巡航 1（经典版） | Deep space cruise pool (`cruise`) |
| `starfall-atrium.mp3` | Lyria 3.5 | 深空巡航 II · 星落中庭 | Deep space cruise pool (`cruise`) |
| `starfall-atrium-classic.mp3` | Suno AI | Starfall Atrium（经典版） | Deep space cruise pool (`cruise`) |
| `stellar-transition.mp3` | Lyria 3.5 | 深空巡航 III · 双星日冕 | Deep space cruise pool (`cruise`) |
| `deep-space-4.mp3` | Lyria 3.5 | 深空巡航 IV · 远星孤航 | Deep space cruise pool (`cruise`) |
| `interstellar-flight.mp3` | Suno AI | 星际飞行 · 超空间跃迁 | Cross-system warp conduit (`warp`) |
| `rift-passage.mp3` | Lyria 3.5 | 弦界航道 · 裂隙凝视 | Dimensional rift portal pool (`rift`) |
| `rift-passage-classic.mp3` | Suno AI | 弦界航道（经典版） | Dimensional rift portal pool (`rift`) |
| `black-hole.mp3` | Lyria 3.5 | 黑洞观测 · 事件视界 | Black-hole accretion vicinity pool (`blackhole`) |
| `black-hole-classic.mp3` | Suno AI | 黑洞观测（经典版） | Black-hole accretion vicinity pool (`blackhole`) |
| `gas-giant-dive.mp3` | Lyria 3.5 | 巨星云渊 · 高压风切 | Gas/ice giant storm cloud dive (`gas-giant-dive`) |
| `halo-skydive.mp3` | Lyria 3.5 | 高空跳伞 · 穿云自由落体 | High-altitude skydive & canopy glide (`skydive`) |
| `lush-planet.mp3` | Lyria 3.5 | 繁茂行星 · 初生原野 | Lush planet daytime (`planet:lush`) |
| `lush-night.mp3` | Lyria 3.5 | 繁茂星夜 · 双月微风 | Habitable planet night (`planet:lush:night`) |
| `ocean-planet.mp3` | Lyria 3.5 | 海洋行星 · 无垠风暴洋 | Ocean planet daytime (`planet:ocean`) |
| `abyssal-dive.mp3` | Lyria 3.5 | 深海潜行 · 幽光海床 | Underwater / seabed exploration (`underwater`) |
| `alpine-summit.mp3` | Lyria 3.5 | 高山雪顶 · 云端雪线 | Habitable snow biome pool (`alpine`) |
| `alpine-summit-classic.mp3` | Suno AI | 高山雪顶（经典版） | Habitable snow biome pool (`alpine`) |
| `ice-planet.mp3` | Lyria 3.5 | 冰封行星 · 极寒晶原 | Ice planet pool (`planet:ice`) |
| `ice-planet-classic.mp3` | Suno AI | 冰封行星（经典版） | Ice planet pool (`planet:ice`) |
| `toxic-planet.mp3` | Lyria 3.5 | 剧毒行星 · 孢子酸雾 | Toxic planet pool (`planet:toxic`) |
| `toxic-planet-classic.mp3` | Suno AI | 剧毒行星（经典版） | Toxic planet pool (`planet:toxic`) |
| `lava-planet.mp3` | Lyria 3.5 | 火山行星 · 熔岩裂谷 | Lava planet (`planet:lava`) |
| `desert-planet.mp3` | Lyria 3.5 | 荒漠行星 · 赤沙远风 | Desert planet pool (`planet:desert`) |
| `desert-planet-classic.mp3` | Suno AI | 荒漠行星（经典版） | Desert planet pool (`planet:desert`) |
| `barren-planet.mp3` | Lyria 3.5 | 荒芜行星 · 寂静月壤 | Barren planet pool (`planet:barren`) |
| `barren-planet-classic.mp3` | Suno AI | 荒芜行星（经典版） | Barren planet pool (`planet:barren`) |
| `exotic-planet.mp3` | Suno AI | 异相行星（经典版） | Exotic planet (`planet:exotic`) |
| `floating-city.mp3` | Lyria 3.5 | 云海浮城 · 天穹气凝胶港 | Aerostat floating habitat (`planet:artificialHabitat`) |
| `frontier-metropolis.mp3` | Lyria 3.5 | 边疆星港 · 核心都市与机库 | Core metropolis pool (`metropolis`), outposts & orbital stations |
| `cyber-metropolis-entry.mp3` | Suno AI | 初入赛博夜城 · 都市进近 | Core metropolis pool (`metropolis`) |
| `surface-combat.mp3` | Lyria 3.5 | 地表交战 · 猎犬围猎 | Active surface robot skirmish (`combat:surface`) |
| `elegy-conflict.mp3` | Suno AI | 古典弦钢冲突曲（预留） | Reserved dramatic/classical conflict (`reserved:elegy-combat`) |
| `space-combat.mp3` | Lyria 3.5 | 太空交战 · 轨道拦截（预留） | Reserved orbital dogfight (`reserved:space-combat`) |
| `space-race.mp3` | Lyria 3.5 | 极速掠地 · 超低空音障（预留） | Reserved racing & high-velocity flight (`reserved:race`) |
| `space-race-classic.mp3` | Suno AI | 太空竞速（经典版预留） | Reserved racing & high-velocity flight (`reserved:race`) |
| `hyperdrive-conduit.mp3` | Lyria 3.5 | 超光速走廊（竞速机动预留） | Reserved racing & high-velocity flight (`reserved:race`) |
| `anomalous-geometry.mp3` | Lyria 3.5 | 非欧几何（科幻机动预留） | Reserved racing & high-velocity flight (`reserved:race`) |

Tracks are streamed lazily via HTML `<audio preload="none">` elements routed
through the shared `AudioContext` (provided by `FlightAudio`). The full
soundtrack is never fetched at load time; each track is requested on first cue
and then cached by the browser via the immutable `Cache-Control` header on
`/assets/`.

**Fork / redistribution notice:** AI-generated music copyright status varies by
jurisdiction and service terms. These tracks are NOT released under MIT. Anyone
forking or redistributing this repository must obtain their own authorization
for commercial use, or replace the tracks under `assets/audio/` with their own
royalty-free / CC0 audio. The game runs normally with the directory removed
(audio load failures are swallowed silently by `src/music.js`).

## Three.js

Vendored under `vendor/`. Copyright (c) 2010-2026 Three.js Authors. Distributed
under the MIT License.
