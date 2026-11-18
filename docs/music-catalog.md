# 《深空》配乐曲库、生成提示词与复用档案

本文档完整归档《深空》全部配乐资产（包含早期保留的优质旧版原曲，以及 2026-11-18 基于 **Google Flow Music 旗舰模型 `Lyria 3.5`** 生成并经 48 kHz 无损 WAV 母带压制的 256 kbps 立体声新曲），同时记录每首曲目的**生成提示词（Prompt）**、**实测听感气质标签**与**跨场景复用建议**，便于后续新玩法、新巨构或剧情演出直接检索复用。

---

## 一、曲库总览与正式落盘映射（2026-11-18，共 42 首：`assets/audio/`）

### 1. 界面与导航状态（3 首）

| 曲目 ID (`src/music.js`) | 实际文件名 (`assets/audio/`) | 来源 | 当前正式绑定场景 | 气质标签与复用备注 |
| :--- | :--- | :--- | :--- | :--- |
| `hero-theme` | `hero-theme.mp3` | Lyria 3.5 | 启动标题页 (`hero-active`) → 开场拉远运镜 | 单音钢琴与温暖光晕合成器起手，渐入圆号与弦乐，庄重开阔 |
| `starmap` | `starmap.mp3` | Lyria 3.5 | 星图与航线确认弹窗池 (`pool:starmap`) | **【重点复用标注】** 清澈玻璃马林巴与柔和微脉冲，极具“飞入一颗静谧、美丽、安全宜居星球”的安定美感，后续可复用于安全区进近、轨道花园或和平据点 |
| `starmap-classic` | `starmap-classic.mp3` | 原版保留 | 星图与航线确认弹窗池 (`pool:starmap`) | 空灵沉静，与新版不重复轮播防听觉疲劳 |

### 2. 太空航行、裂口与极端引力场（13 首）

| 曲目 ID (`src/music.js`) | 实际文件名 (`assets/audio/`) | 来源 | 当前正式绑定场景 | 气质标签与复用备注 |
| :--- | :--- | :--- | :--- | :--- |
| `deep-space-1` | `deep-space-1.mp3` | Lyria 3.5 | 深空巡航池 (`pool:cruise`，6 首轮播) | CS-80/Prophet 温暖合成器垫底 + 稀疏毛毡钢琴与圆号泛音，零重力宇宙尺度 |
| `deep-space-1-classic` | `deep-space-1-classic.mp3` | 原版保留 | 深空巡航池 (`pool:cruise`) | 经典深空氛围，与新曲共同组成 6 首大容量巡航池 |
| `starfall-atrium` | `starfall-atrium.mp3` | Lyria 3.5 | 深空巡航池 (`pool:cruise`) | 延迟清音电吉他泛音 + 室内弦乐长音，带星海远航希望感 |
| `starfall-atrium-classic` | `starfall-atrium-classic.mp3` | 原版保留 | 深空巡航池 (`pool:cruise`) | 与新版共同保留在巡航池 |
| `stellar-transition` | `stellar-transition.mp3` | Lyria 3.5 | 深空巡航池 (`pool:cruise`) | 已替换旧曲；温暖铜管合唱与竖琴/复音合成器，适合近恒星与星环轨道 |
| `deep-space-4` | `deep-space-4.mp3` | Lyria 3.5 | 深空巡航池 (`pool:cruise`) | 极简留白夜航感，平衡巡航池旋律密度 |
| `rift-passage` | `rift-passage.mp3` | Lyria 3.5 | 弦界航道专属池 (`pool:rift`，2 首轮播) | 玻璃琴泛音、微音程弦乐与低频折叠共鸣，契合撕开异星裂口的神秘感 |
| `rift-passage-classic` | `rift-passage-classic.mp3` | 原版重定位 | **移出巡航池** → 弦界航道专属池 (`pool:rift`) | 原曲不适合日常深空巡航，归位至 `riftRoute` 空间裂口展开与穿越 |
| `interstellar-flight` | `interstellar-flight.mp3` | 原版主用 | 跨星系恒星跃迁隧道 (`warp`) | 跃迁正式采用原版 |
| `black-hole` | `black-hole.mp3` | Lyria 3.5 | 黑洞吸积盘邻近池 (`pool:blackhole`，带滞回防抖) | 低音管风琴踏板音、相对论钟摆脉冲与大提琴滑音，巨物压迫与神圣敬畏 |
| `black-hole-classic` | `black-hole-classic.mp3` | 原版保留 | 黑洞吸积盘邻近池 (`pool:blackhole`) | 与新版共同保留轮播 |
| `gas-giant-dive` | `gas-giant-dive.mp3` | Lyria 3.5 | 潜入气态/冰巨星风暴云层 (`gasGiantAltRatio < 0.58`) | 轰鸣低频合成器、旋风质感与弦乐震音，匹配百倍大气压与强风切警报 |
| `halo-skydive` | `halo-skydive.mp3` | Lyria 3.5 (v2) | 高空悬停跳伞与开伞滑翔 (`skydive`) | v2 重制：克制平稳的失重穿云与宁静滑翔脉冲，无突兀炸裂高潮 |

### 3. 星球地表（降落/停泊/舱内闷音过滤/徒步）与水下探索（16 首）

| 曲目 ID (`src/music.js`) | 实际文件名 (`assets/audio/`) | 来源 | 当前正式绑定场景 | 气质标签与复用备注 |
| :--- | :--- | :--- | :--- | :--- |
| `lush-planet` | `lush-planet.mp3` | Lyria 3.5 | 繁茂宜居行星白昼 (`pool:planet:lush`) | 已替换旧曲；指弹原声木吉他 + 合成器气垫 + 长笛弦乐，温暖开阔 |
| `lush-night` | `lush-night.mp3` | Lyria 3.5 | 宜居/海洋行星夜晚 (`dayFactor <= 0.22`，带滞回) | 柔和毛毡钢琴、尼龙弦泛音与夜空合成器，打破单曲循环 |
| `ocean-planet` | `ocean-planet.mp3` | Lyria 3.5 | 海洋世界地表白昼 (`pool:planet:ocean`) | 补齐出生星系 `planet-1` 等海洋世界缺口；晶莹电钢琴琶音与深海低频涌浪 |
| `abyssal-dive` | `abyssal-dive.mp3` | Lyria 3.5 | 水下潜行与海床徒步 (`envUnderwater`) | 低通包裹感模拟垫底、声呐水滴泛音与发光海床梦幻感 |
| `alpine-summit` | `alpine-summit.mp3` | Lyria 3.5 | 宜居雪山群系 (`pool:alpine`，`snowWeight >= 0.35`) | 清透室内弦乐与毛毡钢琴 |
| `alpine-summit-classic` | `alpine-summit-classic.mp3` | 原版保留 | 宜居雪山群系 (`pool:alpine`) | 与新版共同保留轮播 |
| `ice-planet` | `ice-planet.mp3` | Lyria 3.5 | 冰封行星地表 (`pool:planet:ice`) | 钢片琴、高音小提琴泛音与极寒空间混响 |
| `ice-planet-classic` | `ice-planet-classic.mp3` | 原版保留 | 冰封行星地表 (`pool:planet:ice`) | 与新版共同保留轮播 |
| `toxic-planet` | `toxic-planet.mp3` | Lyria 3.5 | 剧毒行星地表 (`pool:planet:toxic`) | 离调模块化合成器与低音单簧管生化感 |
| `toxic-planet-classic` | `toxic-planet-classic.mp3` | 原版保留 | 剧毒行星地表 (`pool:planet:toxic`) | 与新版共同保留轮播 |
| `lava-planet` | `lava-planet.mp3` | Lyria 3.5 | 火山熔岩行星地表 (`pool:planet:lava`) | 已替换旧曲；深沉地质脉动、低音铜管余烬感与克制的远距铁砧重音 |
| `desert-planet` | `desert-planet.mp3` | Lyria 3.5 | 荒漠行星地表 (`pool:planet:desert`) | 孤独杜杜克木管/大提琴与热浪合成器 |
| `desert-planet-classic` | `desert-planet-classic.mp3` | 原版保留 | 荒漠行星地表 (`pool:planet:desert`) | 与新版共同保留轮播 |
| `barren-planet` | `barren-planet.mp3` | Lyria 3.5 | 近真空荒芜星球 (`pool:planet:barren`) | 极简电钢琴单音与大量真空留白 |
| `barren-planet-classic` | `barren-planet-classic.mp3` | 原版保留 | 近真空荒芜星球 (`pool:planet:barren`) | 与新版共同保留轮播 |
| `exotic-planet` | `exotic-planet.mp3` | 原版主用 | 异相行星地表 (`pool:planet:exotic`) | 异相行星正式保留原版 |

### 4. 人类文明、巨构奇观、战术交火与竞速储备（10 首）

| 曲目 ID (`src/music.js`) | 实际文件名 (`assets/audio/`) | 来源 | 当前正式绑定场景 | 气质标签与复用备注 |
| :--- | :--- | :--- | :--- | :--- |
| `floating-city` | `floating-city.mp3` | Lyria 3.5 | 人工浮空城进近与甲板 (`artificialHabitat`) | 补齐气态巨星高空浮城缺口；轻盈电竖琴、Rhodes 电钢与云端露台科技感 |
| `frontier-metropolis` | `frontier-metropolis.mp3` | Lyria 3.5 | 核心大都会池 (`pool:metropolis`) / 地表前哨 / 轨道空间站近域 | 复古未来主义 CS-80 合成器铜管垫底与沉稳工业律动，文明归属感 |
| `cyber-metropolis-entry` | `cyber-metropolis-entry.mp3` | 原版重定位 | 核心大都会池 (`pool:metropolis`，`hero-city-world` <24 km 进近与地表) | **【重点复用标注】** 原 `space-combat` 旧曲；实听无硬核战斗感，极具“随着剧情推进驾船驶入赛博夜之城/科幻巨型都市”的仪式感 |
| `surface-combat` | `surface-combat.mp3` | Lyria 3.5 | 地表前哨敌对机器狗/无人机遭遇战（含脱战 5 秒尾韵） | 硬核战术射击电子混合节奏（128 BPM），清脆瞬态，匹配正面交火 |
| `elegy-conflict` | `elegy-conflict.mp3` | 原版重定位 | 优雅冲突 / 剧情博弈储备 (`reserved:elegy-combat`) | **【重点复用标注】** 原 `surface-combat` 旧曲；钢琴 + 小提琴编织出的古典派弱科幻曲，适合不那么硬核、偏优雅或带宿命感的战斗/防卫挑战 |
| `space-combat` | `space-combat.mp3` | Lyria 3.5 | 太空战斗预留槽位 (`reserved:space-combat`) | 134 BPM 电子管弦混合高速空战张力 |
| `space-race` | `space-race.mp3` | Lyria 3.5 | 竞速 / 高机动储备池 (`reserved:race`) | 142 BPM 破空律动与超低空贴海极速飞行感 |
| `space-race-classic` | `space-race-classic.mp3` | 原版保留 | 竞速 / 高机动储备池 (`reserved:race`) | 与新版共同保留 |
| `hyperdrive-conduit` | `hyperdrive-conduit.mp3` | Lyria 3.5 | 竞速 / 高机动储备池 (`reserved:race`) | **【重点复用标注】** 原 `interstellar-flight` 新曲；118 BPM 模拟音序器与强烈推进感，留作后续竞速玩法或高速穿行任务 |
| `anomalous-geometry` | `anomalous-geometry.mp3` | Lyria 3.5 | 竞速 / 高机动储备池 (`reserved:race`) | **【重点复用标注】** 原 `exotic-planet` 新曲；复合节拍玻璃琶音，兼具浓厚硬科幻氛围与高速机动/竞速感 |

---

## 二、Lyria 3.5 全量生成提示词留档（供后续同风格衍生与场景复用）

> 模型：`Google Flow Music — Lyria 3.5 (Flagship)`，全部启用 `Instrumental: ON`，下载 `48 kHz 16-bit PCM WAV` 母带转 `libmp3lame 256 kbps`。
> **经验提示**：切勿在提示词中写入真实作曲家姓名（如 Vangelis、Hans Zimmer），否则会触发平台静默过滤导致超时；改用具体合成器型号（如 `CS-80`, `Prophet-5`, `Oberheim`, `Buchla`, `Moog`）与配器法描述即可稳定出片。对于常规游戏背景配乐，避免使用 `builds into a soaring...` 或过高 BPM 管弦齐奏，以免后半段动态过载喧宾夺主。

1. **`hero-theme`（主菜单序曲 · 深空远征）**
   ```text
   Iconic main title overture for an epic hard-sci-fi space exploration game. Begins with a single resonant piano note and warm analog halo pad over a sunlit planet horizon, gradually unfolding into noble French horns, lush cinematic strings, and shimmering arpeggiated synthesizers, 70 BPM, dignified, awe-inspiring sense of standing on the threshold of a 1,024-star galaxy, purely instrumental, no vocals.
   ```
2. **`deep-space-1`（深空巡航 I · 银盘微光）**
   ```text
   Vast cosmic sci-fi ambient and minimal neo-classical electronic score. Warm CS-80 and Prophet-5 analog synth pads, sparse felt piano notes echoing in deep starry reverb, subtle evolving modular arpeggio pulse, distant solo French horn and crystalline celesta harmonics, slow 68 BPM, zero-gravity wonder and serene solitude in deep space, ultra-clean 44.1kHz wide stereo studio mix, purely instrumental, no vocals.
   ```
3. **`starfall-atrium`（深空巡航 II · 星落中庭）**
   ```text
   Luminous space exploration post-rock and ambient electronic instrumental score. Crystalline delay-drenched clean electric guitar harmonics, lush evolving chamber string swells, glassy synthesizer bells, deep warm sub-bass foundation, gentle floating 76 BPM pulse, hopeful and majestic interstellar voyage across nebulae, pristine studio production, purely instrumental, no vocals.
   ```
4. **`stellar-transition`（深空巡航 III · 双星日冕）**
   ```text
   Radiant orchestral-electronic space exploration score. Noble warm brass choir swells, shimmering concert harp and vintage poly-synth textures, warm solar drone, subtle hypnotic sequencer pulse at 72 BPM, majestic awe of flying past binary suns and illuminated planetary rings, wide dynamic range, crisp cinematic mix, purely instrumental, no vocals.
   ```
5. **`deep-space-4`（深空巡航 IV · 远星孤航）**
   ```text
   Deeply peaceful minimalist ambient space drift music. Warm velvety Oberheim synth chords slowly morphing over vast cosmic silence, delicate high piano harmonics like distant pinprick stars, gentle sub-bass warmth, 62 BPM, unhurried contemplative night-watch voyage between star systems, ultra-clean noise-free studio master, purely instrumental, no vocals.
   ```
6. **`rift-passage`（弦界航道 · 裂隙凝视）**
   ```text
   Mystical dimensional-portal sci-fi cinematic score. Bowed glass harmonica, shimmering microtonal string harmonics, deep resonant sub-bass spatial fold hum, evolving ethereal granular pads, hypnotic 84 BPM tension that blossoms into luminous awe as a tear in spacetime reveals a distant alien planet, high-fidelity wide stereo, purely instrumental, no vocals.
   ```
7. **`interstellar-flight`（新曲归入高速竞速储备 · 超光速走廊）**
   ```text
   Propulsive cinematic sci-fi warp-transit score. Driving 16th-note analog Moog sequencer, soaring pipe organ and noble brass chords, sweeping kinetic strings, exhilarating sense of relativistic acceleration through a bending corridor of streaking starlight, 118 BPM, cohesive momentum from launch to grand stellar arrival, crisp studio mix, purely instrumental, no vocals.
   ```
8. **`starmap`（银河星图 · 测绘静域 / 安全宜居星球进近）**
   ```text
   Clean cerebral futuristic star-chart interface ambient music. Delicate plucky glass marimba and muted kalimba patterns, warm minimal sub-bass pad, subtle precision astronomical clockwork harmonics and soft modular synth droplets, calm contemplative 80 BPM seamless atmosphere for plotting interstellar routes, crystal clear mix, purely instrumental, no vocals.
   ```
9. **`black-hole`（黑洞观测 · 事件视界）**
   ```text
   Colossal dark hard-sci-fi orchestral-organ score for approaching a supermassive black hole accretion disk. Massive low pipe organ pedal notes, subtle relativistic ticking pulse motif, slow bending cello glissandos, cavernous sub-bass gravitational drone, 60 BPM, terrifyingly vast, solemn and sublime cosmic awe, clean studio dynamics, purely instrumental, no vocals.
   ```
10. **`lush-planet`（繁茂行星 · 初生原野）**
    ```text
    Breathtaking organic-electronic sci-fi frontier exploration score for a lush Earth-like alien planet. Warm fingerpicked acoustic guitar blended with airy analog synth pads, expressive solo alto flute and gentle chamber strings, subtle organic shaker and soft pulse at 82 BPM, sunlit coastal meadows and towering alien forests, warm and Wonder-filled, purely instrumental, no vocals.
    ```
11. **`lush-night`（繁茂星夜 · 双月微风）**
    ```text
    Serene nocturnal sci-fi ambient-acoustic score for nighttime exploration on a lush alien planet. Intimate soft felt piano and gentle nylon-string guitar harmonics, warm nocturnal synth pad, delicate celesta stars and solo cello sigh, 65 BPM, walking through bioluminescent grass under twin moons and milky way band, calm and poetic, purely instrumental, no vocals.
    ```
12. **`ocean-planet`（海洋行星 · 无垠风暴洋）**
    ```text
    Expansive sci-fi cinematic ambient score for a vast alien ocean planet. Deep warm analog synth pads, shimmering crystalline Rhodes arpeggios like sunlight dancing on endless pelagic swells, resonant sub-bass undertow, distant solo cello and airy glass marimba, slow breathing tempo 72 BPM, wide stereo soundstage, awe-inspiring, lonely yet serene, clean high-fidelity studio mix, instrumental only.
    ```
13. **`abyssal-dive`（深海潜行 · 幽光海床）**
    ```text
    Submerged aquatic sci-fi ambient score for walking on an alien seabed beneath bioluminescent waves. Warm muffled low-pass analog pads, echoing sonar-like glass droplets, deep liquid sub-bass currents, glowing harp harmonics and dreamy modular textures, 64 BPM, weightless, mysterious underwater sanctuary, pristine studio mix, purely instrumental, no vocals.
    ```
14. **`ice-planet`（冰封行星 · 极寒晶原）**
    ```text
    Crystalline glacial ambient-orchestral sci-fi score for a frozen ice planet. Sparkling celesta and delicate glass-ice resonances, fragile high violin harmonics, deep sub-zero analog pad drones, sparse echoing piano notes with long pristine hall reverb, 64 BPM, austere, lonely, shimmering arctic beauty under a pale distant sun, purely instrumental, no vocals.
    ```
15. **`toxic-planet`（剧毒行星 · 孢子酸雾）**
    ```text
    Eerie bio-alien electronic ambient score for a toxic spore-filled planet. Subtle detuned Buchla modular synth percolations, bowed metallic waterphone overtones, haunting bass clarinet and muted sul-ponticello strings, slow hypnotic acid-haze bass pulse at 74 BPM, mysterious hazardous alien biochemistry, atmospheric and clean mix, purely instrumental, no vocals.
    ```
16. **`lava-planet`（火山行星 · 熔岩裂谷）**
    ```text
    Smoldering dark cinematic ambient-orchestral score for a volcanic lava planet. Deep tectonic sub-bass rumble, low brass embers, bowed double bass drones, distant resonant metallic anvil and slow ritualistic bass drum pulse at 70 BPM, oppressive heat and glowing magma rivers beneath ash skies, restrained and atmospheric, purely instrumental, no vocals.
    ```
17. **`desert-planet`（荒漠行星 · 赤沙远风）**
    ```text
    Vast sun-baked sci-fi desert planet score. Expressive lonely solo duduk and warm bowed cello melody, shimmering mirage-like analog synth pads, subtle muted plucked acoustic strings and soft distant frame-drum pulse at 75 BPM, towering red canyons and windswept alien dunes under twin suns, cinematic high-fidelity mix, purely instrumental, no vocals.
    ```
18. **`barren-planet`（荒芜行星 · 寂静月壤）**
    ```text
    Ultra-minimalist lonely lunar sci-fi ambient score for a barren airless cratered planet. Sparse isolated vintage Rhodes electric piano and muted felt piano notes with generous silent breathing space, deep subtle vacuum sub-drone, faint radio-astronomy harmonic shimmer, 58 BPM, profound quiet solitude of footsteps in grey regolith dust, purely instrumental, no vocals.
    ```
19. **`exotic-planet`（新曲归入科幻机动竞速储备 · 非欧几何）**
    ```text
    Hypnotic surreal sci-fi chamber-electronic score for an exotic anomalous alien world. Interlocking polyrhythmic glass synth arpeggios, spectral harp harmonics, iridescent granular pads, mysterious Lydian and whole-tone harmonies, 86 BPM, uncanny crystalline monoliths and violet skies, mesmerizing high-clarity stereo mix, purely instrumental, no vocals.
    ```
20. **`alpine-summit`（高山雪顶 · 云端雪线）**
    ```text
    Pure elevated neo-classical mountain ambient score. Intimate felt piano, soaring lyrical solo violin over gentle chamber strings, crisp high-altitude airiness and subtle bell overtones, 66 BPM, standing atop a sunlit snow peak gazing out over an endless sea of clouds on a distant world, peaceful and transcendent, purely instrumental, no vocals.
    ```
21. **`floating-city`（云海浮城 · 天穹气凝胶港）**
    ```text
    Uplifting futuristic architectural ambient-electronic score for a human floating aerostat city suspended high in the golden clouds of a gas giant. Airy poly-synth chords, clean plucked electric harp, warm Rhodes electric piano, gentle sophisticated 84 BPM downtempo pulse, breezy sky-terrace elegance and marvel of human frontier engineering, purely instrumental, no vocals.
    ```
22. **`frontier-metropolis`（边疆星港 · 核心都市与机库）**
    ```text
    Atmospheric neo-noir hard-sci-fi spaceport and megacity ambient electronic score. Warm retro-futuristic CS-80 brassy analog synth pads, steady subtle industrial-downtempo pulse at 80 BPM, clean electric bass, glistening city-light arpeggios, evoking a vast human frontier spaceport, hangar cranes, and warm beacon lights against the starry void, purely instrumental, no vocals.
    ```
23. **`gas-giant-dive`（巨星云渊 · 高压风切）**
    ```text
    Suspenseful monumental sci-fi atmospheric tension score for diving a starship deep into the crushing storm bands of a gas giant. Immense rumbling analog bass drones, swirling wind-like synth textures, tense rising string tremolos and deep brass warnings, 92 BPM pulse, colossal scale and dangerous atmospheric pressure, cinematic mix, purely instrumental, no vocals.
    ```
24. **`halo-skydive`（v2 高空跳伞 · 穿云自由落体与滑翔）**
    ```text
    Restrained, balanced ambient-electronic game background score for floating silently through high-altitude clouds under a parachute. Weightless warm analog synth pads, delicate airy glass marimba and crystal arpeggios, soft deep sub-bass, gentle understated 84 BPM floating pulse that stays calm, smooth, and even-keeled from beginning to end, gradually settling into a serene peaceful canopy glide, steady restrained dynamics with no climax, no build-up drop, no heavy drums, no brass, clean studio mix, purely instrumental, no vocals.
    ```
25. **`surface-combat`（地表交战 · 猎犬围猎）**
    ```text
    Tight tactical hard-sci-fi FPS combat electronic-hybrid soundtrack. Punchy syncopated industrial drums, gritty driving analog synth bassline, tense staccato string ostinatos and sharp modular metallic stabs, 128 BPM, fighting autonomous quadruped hound robots and combat drones at a frontier mining outpost, crisp transient punch, purely instrumental, no vocals.
    ```
26. **`space-combat`（太空交战 · 轨道拦截）**
    ```text
    High-stakes sci-fi space dogfight orchestral-electronic action score. Aggressive low brass stabs, kinetic 134 BPM hybrid percussion, driving arpeggiated synth bass, sweeping minor-key string runs, intense zero-gravity starfighter combat in planetary orbit, clean dynamic studio mix, purely instrumental, no vocals.
    ```
27. **`space-race`（极速掠地 · 超低空音障）**
    ```text
    Sleek futuristic sci-fi flight racing electronic soundtrack. Crisp aerodynamic breakbeat-inflected drums at 142 BPM, propulsive rolling bassline, gleaming analog synth leads and lush atmospheric chords, exhilarating velocity of skimming meters above alien ocean waves in a starship, high-definition stereo mix, purely instrumental, no vocals.
    ```
