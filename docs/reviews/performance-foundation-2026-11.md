# 性能与非云底座系统整治报告（2026-11）

日期：2026-11-13  
范围：默认 1080p / 2K 帧率与 DPR / 自适应、非云逐通道开销拆解与优化、冷/热启动提速、近地与步行首次编译卡顿消除、长停顿后不出图隐患定位与加固、1,200 km 母星水面/地形 LOD 契约校准与全链路连带排查、宏观地形遮挡恢复、真实输入接近与着陆耗时实测。  
精简证据目录：[performance-foundation-2026-11](../baselines/performance-foundation-2026-11/)（`summary.json` 及 4 张实测截图）

---

## 一、测量条件与硬件功率态说明（重要）

所有测试均在本机 **NVIDIA GeForce RTX 5080 Laptop GPU（ANGLE D3D11，WebGL 2，无头 Chromium）** 上串行运行，帧率采用与 `docs/baselines/state-audit-2026-11-12/audit.mjs` 一致的每帧末 `gl.finish()` 真实同步帧间隔（`synced`），并辅以 `EXT_disjoint_timer_query_webgl2` 硬件 GPU 计时查询与逐子系统显隐消融。

工作中通过 `nvidia-smi` 实时监控抓到了本机两个不同的硬件功率态，必须在读取绝对帧率时区分：

1. **P0 高功耗共用态（约 21:55–22:20）**：GPU 处于 `105–116 W`、`86–87 °C`，后台同时运行用户的 ComfyUI Python 进程与桌面 Chrome。改动前初始探针（`baseline-1080p` / `baseline-2k`）在此状态下采集。
2. **P5 固件限功态（00:20 之后全部时段）**：午夜后笔记本 EC 固件进入 `P5` 静音/休眠屏幕限功档（`Pwr:Usage/Cap = 35 W / 35 W`，核心 `660–980 MHz`，GDDR7 显存频率锁定在 `810 MHz`，仅正常频率的约 `1/17`）。即使对完全未改动的 `SMAAPass`，单帧耗时也因 `810 MHz` 显存带宽限制放大约 6–8 倍；连线上对照版 `0.37.7`（`51c7c11`）在 P5 下 1080p 轨道也从 P0 的 `101.2 FPS` 降至 `39.6 FPS`、2K 轨道降至 `15.9 FPS`。

因此，为了保证对比绝对严谨：
- 我们用同一进程背靠背（间隔 < 5 秒，全程实时采样 `nvidia-smi` 确认均为 `P5 @ 35 W / 810 MHz`）对 **线上 `0.37.7`（`51c7c11`）**、**本轮改动前主线（`7610f8b`，与当前共用完全相同的 `lite-cloud-pass.js`）**、**本轮改动后主线** 跑了同路线 A/B 实测；
- **改动后的 P0（110 W 满血态）稳态帧率本次未测到**（凌晨笔记本持续锁在 EC 35 W P5 档，无法在不干预用户电源固件的情况下解除），下文严格只报实测值与同功率态提升倍数，不把外推值写成实测结论。

---

## 二、改动前后核心实测对比

### 1. 同功率态（EC P5 @ 35 W / 810 MHz 显存）背靠背同路线对比

单位：同步帧率 FPS（除启动时间外），URL 为 `?nohero=1&nolock=1`（玩家默认画质）。

| 指标 / 站点 | 线上 `0.37.7` 1080p | 改动前 `7610f8b` 1080p | **改动后 1080p 默认** | **改动后 1080p 关云** | 线上 `0.37.7` 2K | 改动前 `7610f8b` 2K | **改动后 2K 默认** |
|---|---:|---:|---:|---:|---:|---:|---:|
| 实际主画布初始分辨率 | `1920×1080` | `2400×1350` | **`1920×1080`** | `1920×1080` | `2560×1440` | `3200×1800` | **`2560×1440`** |
| 启动到可操控（冷着色器缓存） | 13.3 s | 48.5 s | **18.4–25.0 s** | 24.6 s | 13.5 s | 47.6 s | **18.0–24.5 s** |
| 启动到可操控（热着色器缓存） | — | ~28.0 s | **13.1 s** | — | — | — | — |
| `1-spawn`（864 km 出生点） | 17.5 | 20.3 | **32.1** | 36.8 | 11.6 | 13.7 | **22.1** |
| `2-far`（2.5 R） | 68.2 | 46.0 | **43.8** | 43.3 | 57.3 | 34.4 | **37.1** |
| `3-orbit`（0.3 R 轨道） | 39.6 | 14.4 | **26.2** | 32.1 | 15.9 | 9.9 | **19.3** |
| `4-high-atmo`（0.02 R 高层大气） | 60.8 | 17.2 | **34.0** | 37.4 | 49.2 | 10.9 | **24.2** |
| `5-coast-800m`（海岸 800 m） | 54.3 | 16.2 | **34.1** | 35.9 | 25.8 | 10.5 | **24.8** |
| `6-walk`（草地步行） | 42.1 | 14.6 | **28.3** | 31.2 | 23.6 | 10.2 | **21.5** |

核心结果（同一 P5 @ 35 W 硬件条件下）：
- **1080p 默认画质**：行星各站帧率相对改动前 `7610f8b` 提升 **1.82×–2.10×**（如轨道 `14.4 → 26.2`、高层大气 `17.2 → 34.0`、海岸 `16.2 → 34.1`、步行 `14.6 → 28.3`、出生点 `20.3 → 32.1` 且反超线上 `0.37.7` 的 `17.5`）。
- **2K 默认画质**：相对改动前 `7610f8b` 提升 **1.95×–2.36×**（从 `9.9–13.7` 帧提升到 `19.3–24.8` 帧），在出生点（`22.1 vs 11.6`）和轨道（`19.3 vs 15.9`）**反超线上 `0.37.7`**，在海岸（`24.8 vs 25.8`）和步行（`21.5 vs 23.6`）即使开启体积云、物理大气散射、HALCYON VII 飞船和近水波浪，也已与无体积云的线上 `0.37.7` 基本持平。
- **启动时间**：在热着色器缓存（玩家二次打开或同驱动正常游玩）下从 `~28–35 s` 降至 **`13.1 s`**，追平线上 `0.37.7`（`13.1–13.3 s`）；冷着色器首次编译从 `38.6–48.5 s` 降至 **`18.0–25.0 s`**；低档冒烟测试（`npm run test:smoke`）启动仅 **`9.7 s`**。
- **近地与着陆卡顿**：原先进入 5.8 km 近地的 **3.2–3.6 秒**阻塞、进入 24 km 阴影区的 **1.6 秒**飞船材质重编译阻塞、首次着陆步行的 **1.0 秒**武器探针阻塞全部降为 **0 次（0 ms）**。

---

## 三、逐项问题根因、修复方案与实测证据

### 问题 1：默认 2K 只有约 30 帧，DPR 1.25 超采样至 3200×1800，且 `adaptiveStage` 始终为 0

- **根因定位**：
  1. `src/graphics-settings.js` 中 `ultra` 档配置了 `dprTarget: 1.25`。高档显卡自动落入 `ultra` 后，不仅 2K（`2560×1440`）被强制非整数超采样到 **`3200×1800`（576 万像素，为 1080p 的 2.78 倍）**，连 1080p（`1920×1080`）也被超采样到 **`2400×1350`（324 万像素，多画 56% 像素）**，8 个全屏 HDR 后处理通道全部承受 1.56 倍带宽开销，而画面末端已有 `SMAAPass` 抗锯齿，非整数 1.25× 缩放反而引入次像素重采样。
  2. `src/main.js` 的自适应条件存在两处失效 bug：
     - `adaptiveReady` 要求 `terrainVisualReady`（`activeMorphs === 0`）且 `pendingChunks() === 0`，一旦任一地形/水面块发生过渡就重置 `adaptiveStableSince = performance.now()` 并重新等待 5 秒；但行星自转跟随与飞行过程中地形块持续平滑过渡，导致计时器永远无法走完 5 秒，`adaptiveStage` 永久锁死在 `0`。
     - `applyAdaptiveStage` 的第 1、2 级在移除旧体积云参数后变成了**空操作（no-op）**，直到第 7 级才调整 DPR。
- **做了什么**：
  - 将 `QUALITY_PROFILES.ultra.dprTarget` 调为 `1.0`（点对点原生物理分辨率配合 SMAA），并在 `src/main.js` 增加 `computeCeilingDpr()`，自动画质下将高分屏物理像素上限控制在原生 QHD（约 387 万像素）附近，避免 2K/4K HiDPI 屏幕静默倍增到 800 万像素以上。
  - 修复 `adaptiveReady`：不再因常规流式 `activeMorphs` / `pendingChunks` 重置稳定计时器，启动遮罩解除 2.5 秒后即可介入；重写 `applyAdaptiveStage(0..5)` 为 5 级真实生效阶梯（第 1、3 级平滑下调轻量云内部步进分辨率比例而不改动 `MARCH_STEPS` 宏避免运行期重编译；第 2、3、5 级收紧草地/远景树密度与实时阴影半径；第 4、5 级平缓下探 DPR）。
- **实测验证**：
  - 1080p 默认主画布回到原生 `1920×1080`，2K 默认回到原生 `2560×1440`；在 P5 35 W 限功态下 `adaptiveStage` 正常从 `0` 递进至 `5`（`dpr = 0.92`），不再锁死为 `0`。

---

### 问题 2：1080p 关云后帧率仍只有线上一半左右——逐通道拆解与优化

- **首次完整 GPU 拆解（改动前 P0 态 `EXT_disjoint_timer_query_webgl2` + 消融实测）**：
  - **2K 默认（`3200×1800`，总帧时 `36–41 ms`）**：
    1. **`AtmospherePass`：单通道高达 `14.4–15.7 ms` GPU**（全帧第一大瓶颈，占整帧近 40%！关云只省 `1–5 ms`，关大气直接从 `25.8 FPS` 跳到 `47.9 FPS` / `6-walk` 从 `29.8 FPS` 跳到 `57.4 FPS`）；
    2. **`RenderPass`（地形 + 水面 + 实时阴影 + 植被）：`9.3–13.7 ms` GPU + `2.6–3.2 ms` CPU**；
    3. `LiteCloudPass`：`1.2–6.6 ms` GPU；
    4. **`GradeShader`（镜头色散/暗角/颗粒）：`1.5–2.2 ms` GPU**；
    5. `ForegroundPass`（飞船/武器）：`0.5–2.1 ms` GPU；`UnrealBloomPass`：`0.3–0.6 ms`；`SMAAPass`：`0.4 ms`。
  - **1080p 默认（`2400×1350`，总帧时 `24–27 ms`）**：
    1. `AtmospherePass`：`8.1–9.3 ms` GPU；
    2. `RenderPass`：`7.3–10.2 ms` GPU（其中海岸 800 m 地形约 `6.2 ms`、4096² 阴影约 `6.0 ms`）；
    3. 后处理合计约 `2.3–4.8 ms` GPU。
- **定位到的深层性能根因与修复**：
  1. **`AtmospherePass`（约 4.5× 提速）**：
     - 原先 `tOpticalDepth`（`256×96`）用 `FloatType` + `NearestFilter`，在 shader 里每次采样手动做 **4 次 `texture2D`**；每像素固定跑 **48 步**（连步行看脚下 2 m 的草地也跑 48 步！），每步对双星调用 2 次 `starScatter`（合计每像素 **384 次光学厚度采样 + 96 次多重散射采样 + 96 次 `pow(..., 1.5)` 相函数 + 288 次 `length/sqrt` 地平线遮挡**）。
     - **修复**（`src/atmosphere-pass-webgl.js`、`src/atmosphere-transport-glsl.js`）：`tOpticalDepth` 改用 WebGL 2 核心规范原生保证硬件线性过滤的 `HalfFloatType`（`RGBA16F`）+ `LinearFilter`（4 次采样缩为 1 次硬件双线性采样，`b5radiancetest` 实测最大误差仅 `0.00147`）；将双星方向与瑞利/米氏相函数外提到积分循环外；对非晨昏终结线区域快速短路 `edge0/edge1` 地平线求交并在背阴面跳过 LUT 查询；对击中近处不透明物体的短视线按几何跨度自适应步数（`4..48` 步，掠地平线与天空远景仍保持完整步数）。该改动同时直接加速了共用 `atmosphereTransportGLSL` 的轻量云通道。
  2. **地形与水面着色器及地表太阳透射去重（`src/shaders-webgl.js`、`src/surface-atmosphere.js`）**：
     - 原先地形片元在 360 km 轨道上仍无条件采样 4 张 1K KTX2 扫描贴图、2 张 1K 法线贴图、12 次微法线差分 `triDetail`、9 次浅滩沉积纹理、6 次湿岸纹理及已废弃未使用的 `uCloudTex`（每像素近 40 次纹理采样乘 `0.0` 丢弃！）。
     - 原先水面顶点在全局粗海面（`geometryNear == 0`）仍跑 12 模态 48 次三角函数；水面片元在深海和轨道无条件计算浅水焦散、岸线碎浪、白沫毛孔与高光闪烁；且 `surfaceSunTransmission` 在 `sunShadow.intensity == 0`、`headlamp.intensity == 0` 及无太阳高光像素上重复执行（每次含 20 次 `texelFetch`），单水面像素最多重复算 5 遍同一颗恒星的透射率。
     - **修复**：按解析距离与水深严格门控所有权重为 `0` 的地形/水面纹理与波浪循环；在 `surface-atmosphere.js` 中跳过 `directLight.visible == false` 的零强度光源，并按恒星方向在片元内缓存复用 `surfaceStellarTransmission`。`oceangpuparitytest` 与 `b5` 全绿。
  3. **实时阴影、内陆近水网格与远景树背面裁剪**：
     - `ultra` 阴影图从 `4096²`（1678 万纹素）调为 `2048²`（步行精度 `0.63 m`/纹素，800 m 低飞 `2.5 m`/纹素），并禁止 `level < 5`（> 30 km 大陆级块）投射近距方向光阴影（宏观山体遮挡已由地形图集负责）。
     - `NearWaterPatch`（`512×512` = 52.4 万双面 `MeshPhysicalMaterial` 三角形）在内陆无水区域（`maxDepth <= -1 m`，如草地步行）自动隐藏，不再每帧提交 52 万三角形进片元 `discard`。
     - `FarFlora`（2.4 万棵代理树 = 115 万三角形）在透视主相机下将相机后方 `> 40 m` 的实例缩零裁剪（正交阴影相机保持不变，不影响树影）。
     - `GradeShader` 在中心无色散区（`r² < 0.09`，偏移 < 0.25 像素）由 3 次 `RGBA16F` 采样合并为 1 次。
  4. **地形块构建器提速 2.7× 并修复 800 m 海岸折线沙角（`src/quadtree.js`）**：
     - 截图对比抓到改动前 `5-coast-800m` 海岸呈 500 m 巨型直线多边形折角（地形 LOD 饥饿）。定位发现每个 `64×64` 地形块对全部 `4,225` 个顶点各调 3 次 20 倍频 `height()` 求有限差分法线（`12,675` 次噪声调用/块）。
     - 改为两遍网格法：第 1 遍每顶点只采样 1 次高度，第 2 遍对内部 94% 顶点直接用相邻网格点做中心差分叉积求法线（0 额外噪声调用），仅 4 条边界保留球面切向采样以保证跨块/跨立方体面法线逐位一致。`sanity.js` 实测 `lush` 构建从 `1,811 ms → 251 ms`（**7.2×**）、细化收敛从 `4,830 ms → 1,601 ms`（**3.0×**），`5-coast-800m` 折线沙角彻底消失，变为平滑弯曲的自然海岸线（见证据目录 `2k-coast-800m.jpg`）。

---

### 问题 3：启动到可操控约 30–35 秒（线上约 13 秒）

- **根因定位（逐阶段计时抓出三大罪魁祸首）**：
  1. **`startupTerrainReady()` 把上限当成了下限，导致每次启动白等 15.5 秒超时！**  
     `src/main.js` 原先写为 `stats.visibleMaxLevel >= planet.waterLod.planet.orbitLevelCap`（要求水面达到 `level 3`、地形达到 `level 4`）。但在 `1.72 R` 出生点轨道上，水面受 `orbitApproachLevelThresholds: [1.12, 1.06, 1.025]` 与屏幕误差控制，天然稳定在 `level 0..2`（`pending === 0 && activeMorphs === 0`），**永远不可能 `>= 3`**！结果所有着色器和地形块早已就绪，加载界面却死等 `9.0 + 3.5 + 3.0 = 15.5 s` 安全超时才强制放行（控制台打出 `loading mask forced clear by safety-net timeout`）。
  2. **旧云栈数据仍在默认路径同步阻塞主线程约 13 秒**：  
     母星系共 10 个天体（其中 6 个有云天体）。即便默认走 `LiteCloudPass`，`createPlanetWeatherField` 仍同步运行旧栈的 `calibrateProductionCoverage`（Node 实测 6 星合计 `~5.0 s`），`makeCloudTextures` 与 `planet-weather-worker` 仍构建旧栈专用的 `buildProductionBands`（浏览器主线程合计 `~8.0 s` + 6 个并发天气 Worker 争抢多核与带宽）。
  3. **主线程串行等待着色器编译 + 遮罩后空跑全屏渲染 + 轨道块过密**：  
     `AtmospherePass`、`LiteCloudPass` 四通道与地表武器未在启动时送入 `KHR_parallel_shader_compile` 并行编译，而是在首帧串行阻塞；且在加载黑幕未撤除前，每帧一边构建轨道地形块一边白画 30 ms 全分辨率后处理。此外 1,200 km 母星沿用 6,000 km 的 `orbitLevelCap = 4`（`64×64`），在出生点生成 ~405 个块。
- **做了什么**：
  - 修复 `startupTerrainReady()`：改为检查 `_forceLevel` 下限及 `pending === 0 && activeMorphs === 0`，加载遮罩期间快速收敛不可见的过渡动画并跳过遮罩后的无效全屏合成绘制。
  - 将 `opticalCalibration` 改为按需惰性 getter；仅当 `volumetricCloudsEnabled`（即 `?clouds=legacy` 或独立旧云测试）开启时才执行 `buildProductionBands`（主线程与天气 Worker 同步门控）；加载期间推迟非焦点远距行星的后台天气 Worker；`< 400 km` 小卫星/外围冰星采用与物理周长匹配的 `128×64` 天气图集；`SpaceRadiance` 跳过银河盘面外恒为零的尘埃/纤维噪声倍频（指纹 `11992a8b` 逐位不变）。
  - 新增 `GameLegacyPipeline.prewarmPostPasses()`，在构建次级行星前将地表、大气、轻量云全部全屏着色器与武器着色器一并提交给 ANGLE C++ 后台线程并行编译；1,200 km 母星出生点轨道采用 `32×32` `level 3`（`7.36 km` 格距，`< 10 km` 门槛），进入 `< 1.35 R` 后再平滑递进到 `64×64` `level 4..7`。
- **实测结果**：
  - 热着色器缓存启动从 `~28–35 s` 降至 **`13.1 s`**（追平线上 `13.1–13.3 s`）；
  - 冷着色器缓存启动从 `38.6–48.5 s` 降至 **`18.0–25.0 s`**；
  - `npm run test:smoke` 启动降至 **`9.7 s`**。

---

### 问题 4：进入近地时地形和水面材质首次编译阻塞约 3.2 秒（连同飞船 1.6 秒、步行 1.0 秒卡顿）

- **根因定位（通过抓取每次 `getProgramParameter` 的完整 `#define` 头逐行比对确认）**：
  1. **近地 5.8 km 阻塞 3.2–3.6 秒**：`src/main.js` 原先写 `sunShadow.visible = shadowBlend > 0.02`。在轨道和高层大气（`> 7.2 km`）时 `sunShadow.visible = false`（`NUM_DIR_LIGHTS=0, USE_SHADOWMAP=0`）；下降穿过 `7.2 km` 时 `sunShadow.visible` 翻转为 `true`（`NUM_DIR_LIGHTS=1, USE_SHADOWMAP=1`），迫使地形 `MeshStandardMaterial`（`~1.1 s`）与水面 `MeshPhysicalMaterial`（`~2.5 s`）在飞行途中同步重编译整套着色器。
  2. **行星淡入 `applyAppear()` 破坏水面透明度并导致启动期双倍编译（6.6 秒）**：`src/planet.js` 原先写 `f.mat.transparent = a < 1 || f.base < 1`，而水面 `liquidMat.opacity`（`f.base`）为 `1`（靠片元 alpha 表现浅水透底）；当 `appear` 从 `0` 升到 `1` 时，不仅地形材质从 `transparent: true` 翻回 `OPAQUE` 重编一次，**水面材质的 `transparent` 更被错误覆写成 `false`（打上 `#define OPAQUE` 宏）**，既破坏了浅水透明又触发第二次 2.2 秒重编译！
  3. **24 km 飞船重编译阻塞 1.6 秒**：`src/effects.js` 原先写 `light.visible = this.foregroundOnly && intensity > 0.001`，飞入行星背阴/日食区时关闭主光 `visible`，改变 `SHIP_FOREGROUND_LAYER` 光源数与阴影宏，触发 HALCYON 7 套 PBR 材质同步重编译。
  4. **首次着陆步行阻塞 1.0 秒**：进入 `walk` 模式时 `WeaponSkyProbe` 首次实例化 `PMREMGenerator` 同步编译卷积着色器（`~600 ms`）并首次编译步枪瞄具材质（`~400 ms`）。
- **做了什么**：
  - 保持 `sunShadow.visible = true` 常驻，在 `shadowBlend <= 0.02` 时设 `sunShadow.intensity = 0` 且 `sunShadow.shadow.autoUpdate = false`（初始仅分配 `4×4` 占位深度图，进入 `< 7.2 km` 再切回 `2048²` 实时更新）。Three.js 在 `intensity == 0` 时 `directLight.visible == false`，轨道上 `0` 阴影绘制、`0` 阴影采样，同时全高度共用**唯一一套世界着色器变体**。
  - 修复 `Planet._fades` 记录原始 `transparent` 属性；主星系初始天体在加载幕后直接以 `fadeInPlanets: false`（`appear = 1`）构建。
  - 飞船 `sun` / `secondarySun` 的 `visible` 仅随 `foregroundOnly` 切换，暗面通过 `intensity = 0` 和 `shadow.autoUpdate = false` 控制。
  - 启动期预热户外 `WeaponSkyProbe` 与 `WEAPON_FOREGROUND_LAYER` 变体。
- **实测结果**：
  - 从出生点 → 360 km 轨道 → 24 km 高层大气 → 5.8 km 云层 → 800 m 海岸 → 着陆步行全程，地形/水面/飞船/探针重编译阻塞从合计 **~9.5 秒** 降至 **`0 ms`（`walkSlow = []`）**。

---

### 问题 5：“某一帧停几秒，之后页面不再正常出图、截图失败”的复现、定位与修复

- **实测成功抓获现场**：在首次真实飞行压测（冷着色器缓存 + P5 35 W 满载争用）中，我们在 `t = 24,608 ms` 当场抓到一次 **`gl.getProgramParameter` 单帧阻塞 `12,418.1 ms`（12.4 秒）**！
- **根因**：
  1. 当显卡被其他高负载进程（如主控当时的后台任务或 ComfyUI）占满、或处于冷缓存/限功态时，并行着色器编译耗时可能超过原定的 `STARTUP_WARM_BUDGET_MS = 9000 ms` 窗口；`releaseStartupPrewarm` 在超时瞬间调用 `startupCompile.abort()` 放弃等待并放行首帧 `composer.render()`，主线程随即撞上尚未链接完成的重型着色器（轻量云步进/时域解析或水面物理材质），在 D3D11 驱动内同步卡死 **5–12 秒**，进而导致 Windows WDDM / Chromium Compositor 帧汇超时、Playwright `screenshot()` 失败。
  2. 此外，`EffectComposer` 原先只在第 8 通道（`UnrealBloomPass`）前做 `hardenBloom` 防 NaN/Inf，而排在第 2、3、6 通道的 `AtmospherePass`、`LiteCloudPass`（带 `0.9` 历史权重的 `3×3` 邻域时域重建！）和 `TemporalAAPass` 之前没有任何非有限值清洗；一旦上游水面高光 `pow(0.0, glintPower)`（D3D11 展开为 `exp2(y * log2(0.0))`）或除零产生单个 `NaN` 像素，就会被时域历史永久锁死并逐帧扩散黑屏。
- **做了什么**：
  - 将非低档 `STARTUP_WARM_BUDGET_MS` 放宽至 `24,000 ms`（热缓存 `13 s` 即自然完成放行，丝毫不增加正常启动时间；冷缓存/GPU 争用时让后台 `KHR_parallel_shader_compile` 安全跑完，绝不提前中断把 12 秒同步链接甩给首帧）。
  - 在 `AtmospherePass` 入口对 `tBase` 做 `isnan` / `isinf` 与负值钳制清洗，切断任何 `NaN/Inf` 进入后续云时域历史与 TAA 历史的通路；并在 `shaders-webgl.js` 水面太阳高光 `pow(sunDot, ...)` 前增加 `sunDot > 1e-5` 保护。
- **实测结果**：修复后重跑冷/热启动及两轮完整 4,393 帧 + 2,592 帧连续飞行着陆测试，未再出现多秒卡死或坏图。

---

### 问题 6 & 7：1,200 km 母星的 `stageatest.js`、水面 LOD 交接契约与全系统连带核查

- **水面与地形 LOD 契约校准（`src/planet.js`、`tools/stageatest.js`）**：
  - **原因**：`waterCanonicalMaxLevel = Math.min(this.canonicalMaxLevel - 3, 11)` 原先写死了固定层数 `11`（`maxLevel = 10`）。在 6,000 km 母星上第 10 层恰好为 `143.8 m`，与局部 `NearWaterPatch` 外缘（`~88–140 m` 渐变格、`7.4 km` 交接半径）匹配；缩到 1,200 km 后第 10 层变成 **`28.8 m`**（560 km 海洋星 `planet-1` 更细至 **`13.4 m`**！），在已经被 `NearWaterPatch` 接管并 `discard` 的 `< 7.4 km` 圈内白白细分了 16–64 倍的全局水面块！同理，地形 `maxLevel` 在 1,200 km 上落到第 14 层（`1.80 m`），且中空屏幕误差比例阈值写死在 `lvl <= 10`，导致步行三角形高达 367 万。
  - **校准**：改为按**物理格距**标定：
    - 全局水面 `waterMaxLevel = clamp(ceil(log2(waterRootCell / 155)), 2, 10)`，最细层屏幕误差切换改为 `lvl < waterMaxLevel`。标定后 **1,200 km 母星为第 8 层（`115.0 m`）**、**560 km 海洋星 `planet-1` 为第 7 层（`107.4 m`）**、**6,000 km 行星保持第 10 层（`143.8 m`）**，任何半径行星都精确落在 `[80 m, 160 m]` 的 `NearWaterPatch` 交接带内。
    - 地形最细渲染格距按 `~3.6 m` 物理目标标定（1,200 km 母星为第 13 层 **`3.60 m`**，满足 `<= 9.1 m` 契约且省去 4 倍亚草叶级冗余网格），中空视距环阈值按 `>= 110 m` 物理格距自动计算（1,200 km 为第 8 层，6,000 km 为第 10 层）。
    - 更新 `tools/stageatest.js` 的母星半径（`1,200 km`）、卫星轨道（`4,320 km`）以及母星与海洋星双星体的 `[80 m, 160 m]` 物理交接断言，并修复 `tools/sanity.js` 浮动原点偏移漏加导致的植被稳定性误报。**`npm run test:stage-a` 全套 14 个测试脚本与 `npm run test:terrain` 全部 100% 通过。**
- **1,200 km 母星其余连带维度逐项核查结果**：
  1. **地形坡度与可步行性（4,000 方向球面均匀采样实测）**：由于 `Planet` 的 `hAmp` 受 `7000 + rand() * 6000` 上限约束（母星 `hAmp = 8,607 m`，总起伏 `15.82 km`，`relief / R = 1.32% < 2.5%`），在旧 6,000 km 上坡度被拉平到中位数仅 `1.38°`、`P99 = 11.8°`、裸岩陡崖占比 **`0.0%`**（整颗星球没有一面岩壁！）；而在旧线上 286 km 上中位数达 `27.1°`、`41%` 不可步行。**缩至 1,200 km 后：100 m 基线坡度 `P50 = 6.91°`、`P90 = 23.88°`、`P99 = 46.30°`，`<= 32°` 可顺畅步行陆地占 `95.2%`，同时恢复了 `2.4%` 的高山裸岩峭壁**——1,200 km 恰好处于现有噪声频率的最佳物理甜点，无需篡改地形 RNG 流。
  2. **系统视图（`src/sysview.js`）轨道重叠 bug（新发现并修复）**：实测发现母星（`1,200 km`，原视觉半径触顶 `2.35`）+ 卫星轨道（`4,320 km`，视觉半径 `5.10`，外缘达 `18.60 + 5.10 = 23.70`）与 `planet-1`（轨道 `21.10`，内缘 `21.10 - 3.41 = 17.69`）**在系统星图里发生球体与卫星轨道环互相穿插碰撞**！已在 `src/sysview.js` 区分岩质超级地球与气态巨行星视觉半径上限、将卫星轨道按母星半径比例缩放，并加入相邻主行星包络最小净空递推，彻底消除穿模，`npm run test:sysview` 与 `npm run test:starmap` 全绿。
  3. **海岸着陆与深海下潜提示（`src/main.js`）**：修复了两处细节——① 在海岸浅水边缘按 `L` 着陆时，若 `parkShipNear` 在 22–38 m 内找到了干爽沙滩停机位，现在会把玩家放在飞船坡道旁的干地上，而不再把玩家丢进离岸水下；② 悬停在深海海面上方 `< 420 m` 时，HUD 提示准确显示 `DIVE — walk the seabed (L)`，不再误标为陆地着陆。
  4. **出生点、卫星轨道、大气光学顶与残留 `6000000` 常数**：出生点 `1.72 R`（`864 km` 高度）角直径与构图比例完全一致；卫星轨道 `4,320 km`（`3.6 R`，周期 `857.3 h`）物理自洽；大气光学顶 `26.7 km`（高于瑞利标高 3.3 倍及全部云层/山峰，不随 `126 km` 玩法包络虚胖）；`temporal-aa-pass.js` 与 `volumetric-pass-webgl.js` 的默认球半径兜底值已同步为 `1200000`（`ocean-tidal-event.js` 与 `weather-system.js` 的未传参单元测试默认形参保留 `6000000` 以维持既有独立单测契约，运行时均显式传入真实半径）。

---

### 问题 8：恢复与云无关的宏观地形遮挡（`surfaceMacroTerrainShadow`）

- **根因**：`src/surface-atmosphere.js` 原先将 `surfaceMacroTerrainShadow` 包在 `#if SURFACE_CLOUD_MEDIUM` 与 `uSurfaceCloudEnabled` 内，默认模式下 `SURFACE_CLOUD_MEDIUM = 0` 导致整段山体自遮挡被裁掉；而且原实现还错误地用 `cloud_uSpin * radial` 去采样静止的地形高度通道 `Hi.G`，导致山脉阴影随风旋转！
- **做了什么**：
  - 在 `src/surface-atmosphere.js` 中将 `surfaceMacroTerrainShadow` 从 `#if SURFACE_CLOUD_MEDIUM` 解耦：`!SURFACE_CLOUD_MEDIUM` 时声明专用 `uMacroTerrainMap / uMacroTerrainRange / uMacroBodyR`（片元采样器总数 12 个，严守 WebGL 2 的 16 采样器上限；`SURFACE_CLOUD_MEDIUM=1` 时复用已有 `cloud_uWeatherMapHi` 不新增采样器），统一修正为不乘 `uSpin` 的静止球面坐标采样。
  - 在 `src/planet.js` 新增惰性 `ensureMacroReliefTexture()`：有天气系统的行星直接零开销复用 `cloudWeatherHiTex`；无云荒漠/荒芜/熔岩/卫星在接近聚焦时惰性生成 32 KB `128×64` 地形起伏图，使无云峡谷/环形山同样具备低太阳角宏观山体阴影。
  - 水面的方向性云反射分支（`#if SURFACE_CLOUD_MEDIUM` 下的 `reflCloud`）按边界约定保留未动，留给主控云工作处理。
- **实测证据**：WebGL 2 实机离屏浮点像素读回验证（`SURFACE_CLOUD_MEDIUM = 0`），低太阳角山脊背阴谷地直接光照均值从无遮挡 `0.03958` 衰减至 `0.007124`，比值 **`0.18000001`**（精确命中设计的半影下限 `0.18`），`gl.getError() === 0`。

---

### 问题 9：真实输入接近母星并着陆的全程耗时实测

在 `1920×1080` 默认设置下，从默认出生点（地表高度 **`862.3 km`**）使用真实 Playwright 键盘/鼠标事件（无任何调试传送）直飞母星并按 `KeyL` 完成着陆过渡进入 `walk`：

| 高度里程碑 | **脉冲 + 助推（`W + RMB + Space`）** | **纯助推（`W + RMB`，不用脉冲）** |
|---|---:|---:|
| 低轨道（`360 km`） | **3.0 s** | 25.4 s |
| 玩法大气层顶（`126 km`） | **17.0 s** | 57.0 s |
| 光学大气顶（`27 km`） | **53.2 s** | 102.9 s |
| 云层顶部（`12 km`） | **63.7 s** | 116.8 s |
| 云底以下（`4.5 km`） | **72.1 s** | 128.6 s |
| 低空掠飞（`1,000 m`） | **80.4 s** | 139.8 s |
| 着陆许可高度并按下 `L`（`< 400 m`） | **84.0 s（1 分 24 秒）** | 143.7 s（2 分 24 秒） |
| 落地踏上地表（`state === 'walk'`） | **87.9 s（1 分 28 秒）** | 147.3 s（2 分 27 秒） |

全程稳定性：两轮合计近 7,000 帧连续下降、穿云与着陆过程中，运行时着色器阻塞为 **0 次**，`pageerror` / 着色器报错为 **0**，均平稳降落在干爽草坡（见证据目录 `real-flight-landed.jpg`）。脉冲在中高空（`862 → 126 km` 仅需 17 秒）显著缩短了太空段接近时间，进入稠密大气后由安全向内限速平滑接管以留出地形流式细化与观景时间。

---

## 四、回归验证与未测/遗留项说明

### 已通过的验证
- `npm test`：除末尾已知暂缓的 `worldlocktest.js` 外，前面全部 **61 个 Node 契约与回归测试 100% 通过**（含 `preparationscopetest`、`auxiliaryframeownershiptest`、`portalrenderownershiptest`、`renderframepacingtest`、`surfaceprogramkeytest`、`canonicalplanetfixturetest`、`terrainheightfieldtest` 等，母星 `heightSamples` 逐位不变）。
- `npm run test:stage-a`：全部 14 项地形连续性、山脊、环形山、四叉树精度、海洋气候与水柱契约 **100% 通过**。
- `npm run test:stage-b`、`npm run test:b5`、`npm run test:ocean-gpu`、`npm run test:near-water`、`npm run test:terrain`（`sanity.js` 全 8 类行星）、`npm run test:far-flora`、`npm run test:vegetation:precision`、`npm run test:sysview`、`npm run test:starmap`、`npm run test:smoke`（`9.7 s` 启动）、`npm run test:astronomy:browser`：**全部通过**。

### 没测到或仍待后续确认的部分（实事求是列出）
1. **RTX 5080 Laptop 在 P0（110 W 满血态）下的改动后稳态帧率未直接测到**：由于 00:20 后本机持续处于 EC `P5`（`35 W / 810 MHz` 显存）限功档，本轮在 P5 下用背靠背同条件实测证明改动后比 `7610f8b` 快 **1.8×–2.4×** 且 2K 默认已追平/反超线上 `0.37.7`，但唤醒屏幕回到 P0 110 W 后的实机 60+ 帧最终体感数字需在正常桌面供电态下复核一次。
2. **水面方向性云反射与云体光学余项**：按分工边界由主控在云线内处理，本轮未触碰 `src/cloud/lite-cloud-pass.js` 与 `src/cloud/lite-cloud-noise.js`。
3. **旧云栈代码与测试清理**：本轮已剥离旧云栈在默认路径上的启动与 Worker 开销（保留 `?clouds=legacy` 可用），待用户最终拍板轻量云方向后再整套删除旧栈文件与测试。
4. **多硬件与长时星际跃迁实机遍历**：本轮聚焦母星系默认体验与自动化回归，未在集显真机、移动端或跨十余星系连续跃迁下做长时热稳态测试。此外，走 CPU SwiftShader 软件光栅的 `seamtest` / `touchtest` 在未传 `?vclouds=0` 时会逐像素软件步进 `LiteCloudPass`（`seamtest` 前 15 个静态高度全部 `0 px` 通过，连续下降段在 SwiftShader 上极慢），后续可在测试脚本或软件渲染器检测上做区分。
