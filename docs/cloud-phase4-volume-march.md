# 阶段 4 — 体积 march 与光照（写实）专项实施文档

> ⛔ **[2026-08-15 停牌] 随云/大气 WebGPU 重写计划整体封存,不再按原文执行**(见 `cloud-atmosphere-rewrite.md` 顶部声明与 `optimization-roadmap.md` 决策日志)。**活跃任务规格以 `optimization-roadmap.md` 批次 B(2.2/2.8)为准**——载体 `clouds-webgl.js`/`atmosphere-webgl.js`/`legacy-render-pipeline.js`,增量演进;本文档降级为体积 march/光照的算法与验收参考档案。
>
> **归档使用指引(哪些仍有效/哪些已死):**
> - ✅ **仍然有效,实施时直接复用**:§1 光照架构与来源复审(双叶 HG/多八度近似/phi_fwd 实验门控)、§1.2 锥形自阴影参数、§1.3 高空薄云独立路径、§2 HP 形态映射表(全部与着色语言无关)、§4 四机位/找茬/盲评/照片盲测协议、§6 验证记录(历史证据)。CPU 侧资产未随 TSL 线删除:`src/cloud/` 的 `cloud-density.js`/`cloud-occupancy.js`/`cloud-species.js`/`cloud-resource-manager.js`/`cloud-field-worker.js`/`weather-system.js` 仍在生产与 `npm test` 中,§0 接口表对应行继续有效。
> - ❌ **已死,不得执行**:§0 硬约束第 1 条(禁止 GLSL——已反转);§3 标题与正文的 TSL/`cloud-volume-node.js`/`node-render-pipeline.js`/`volume-depth-node.js` 载体;§0 接口表的 `cloudDensityTSL` 与 `temporal-policy.js`/`temporal-resolve.js` 两行(文件已删除);§5 A 组复选框的"完成"仅指已删除的 WebGPU 线,B/C/D 未开工且不得按 TSL 载体开工。
> - 🔄 **载体转换对照**(若在 GLSL 链重新实施写实 march):`cloudDensityTSL()` → GLSL 采样函数(直接消费同一套烘焙 3D 纹理,WebGL2 原生支持 `sampler3D`);`cloud-volume-node.js` → `clouds-webgl.js` 或新 `cloud-volume-webgl.js` 内的 `ShaderMaterial`;`node-render-pipeline.js` 接线 → `legacy-render-pipeline.js` 体积 pass + `WebGLRenderTarget.depthTexture`;`volume-depth-node.js` 的遮挡截断 → 同一 depth texture 的场景射线限深;WebGPU readback 一致性验证 → WebGL2 `readPixels`;`queue.writeTexture` 分帧上传 → `texSubImage3D`;WebGPU 设备丢失恢复 → `webglcontextlost/restored`。

> **状态（2026-08-10）：A“基建与 march 骨架”已完成；B 光照、C 形态与 D 最终验收未完成。** 本文档是阶段 4 的唯一权威细节来源；阶段 2 的旧“已完成”前提、静态屏幕 hash 和未经验证的 phi_fwd“直落”结论均已撤销。
> **上下文压缩后读这里就够了**：§0 给了你继续实施所需的全部接口与常数，不需要去读旧云实现，也不需要回头读主文档全文（主文档 §8 的光照推导本节会引用到具体条目，用到再查）。

---

## 0. 上下文（开工前必读）

**项目**：Three.js 太空游戏，`D:\Eray0\Documents\_GitRES\Game\深空`(重写期为 WebGPU/TSL 线,该线已于 2026-08-15 删除;现生产基准 WebGL 2/GLSL)。阶段 0/1 完成；阶段 2 连续运动失败并入阶段 7；阶段 3 已由 A2 的真实 WebGPU readback 闭环。阶段 4 当前只完成 A，不能据此宣称写实云或完整阶段 4 已完成。

**阶段 4 在重写中的位置**：阶段 1 建了天气体系；阶段 3 现在提供 CPU 介质、图集、占用体与采样计划。**阶段 4 先补齐资源所有权和 TSL/GPU 一致性，再把云真正画出来**：GPU 体积 march + 写实光照。失败既可能是数值/所有权错误，也可能是观感错误，因此必须同时经过硬件数值闸门、多条件截图评审和用户实机验收。

**可直接使用的接口（阶段 3 已交付，全部在 `src/cloud/`）**：

| 接口 | 位置 | 用途 |
|---|---|---|
| `createCloudFields(system, options)` | cloud-density.js | 烘焙全部随机输入：shape RGBA 3D（fbm/worley/两条精细抖动车道）、detail R 3D、jitter 2D（区域抖动/地形）、bands 图集（14 壳内云种 × RGBA=weight/base/top/1） |
| `cloudMediumCPU(...)` / `cloudDensityCPU(...)` / ~~`cloudDensityTSL(...)`~~ | cloud-density.js | CPU 介质参考与同一烘焙纹理驱动的 GPU 采样(~~TSL 实现已随 WebGPU 线删除~~;GLSL 链实施时按顶部载体转换对照重写采样函数)；A2 曾用真实 WebGPU 固定切片和随机点 readback 闭环 |
| `measureCloudFieldCoverage()` / `cloudFieldByteLength()` | cloud-density.js | 验收最终光学覆盖率与资源字节数，不能再只看天气代理或估算 |
| `buildOccupancyVolume(fields, options)` | cloud-occupancy.js | 占用体（128×64×32 生产规格） |
| `clipRayToOccupancy(occupancy, origin, dir)` | cloud-occupancy.js | 精确球面 DDA，返回占用段序列（tEnter/tExit/segments），null = 晴空射线零采样 |
| `planRayMarch(clip, origin, dir)` | cloud-occupancy.js | 逐段步长计划。GPU march 照它走：段内固定步长、段间跳过 |
| ~~`createTemporalPolicy()` / `createTemporalResolve()`~~ | ~~temporal-policy.js / temporal-resolve.js~~(两文件已随 TSL 线删除) | 失败原型，生产默认禁用；结论仍然有效:无光流补偿的局部累积在连续运动下不可用,TAA/history 统一归后续批次决策 |
| `MORPHOLOGY_PARAMS` / `CLOUD_SPECIES` | cloud-density.js / cloud-species.js | 7 种形态参数（noiseMix/vStretch/erosion/peak）+ 16 云种表（extinctionPerKm 等光学参数在这里） |

**关键常数**：壳内最薄特征 400 m → 安全步长 80 m（/5 规则）；云种最坏壳顶 14940 m，实例 fields 再包含地形/细抖动上界；`GRAZING_COS_FLOOR = cos85°`；占用体对图集保守。**4 个样本只是防漏采底线，不是最终画质档。**

**硬约束**：
- ~~WebGPU 主线只用 TSL/NodeMaterial，禁止 GLSL ShaderMaterial / onBeforeCompile。~~ **[2026-08-15 已反转:GLSL `ShaderMaterial`/`onBeforeCompile` 是唯一实现路径(AGENTS.md 渲染后端);WebGPU/TSL 线已从工作树删除,本条为存档,不得执行]**
- **时域累积器当前默认禁用（2026-08-06）**：阶段 2 的局部累积器在真实大幅连续转镜下会把整颗星球变成噪点幕。**本阶段全程关闭。** 阶段 7 的全屏 TAA 是运动稳定性的必做项；体积 history 是否用于采样摊薄则必须由质量/性能实测决定。
- **大气只是确定性临时版，不是“不闪”基线**：`planet.js makeAtmosphereMaterial` 已移除 frame jitter，每视线步做 4 子步太阳 OD，双星+日食接口保留；三档视线步已临时抬到 16。但固定步数仍可能欠采样掠射光程，大气仍与云共用 0.46× pass，所以阶段 4 的运动验收必须能单独开关大气并做光流补偿对照。阶段 5 负责最终 LUT/自适应积分和全分辨率轮廓。
- 全 0/全绿的数值指标不等于成功，必须配合多条件截图和用户实机评估。
- 不允许攒到最后验证：§5 的复选框按顺序勾，每步有验证。

**资源与更新所有权（阶段 4 开工前先落）：**
- 云场在 worker 生成，任务带 planet/generation token，可取消；主线程只调度和分帧上传，不能承受当前默认场约 5.8 s 的同步生成。
- 2026-08-10 当前生产规格三种子实测 CPU 44.53 MiB/行星、GPU 44.50 MiB/行星，worker 冷生成 5.87–5.97 s。常态一个活动行星；门户/跃迁可短暂保留当前+目标两个，handoff 后 2 帧内释放旧 GPU 纹理与 CPU 缓存。
- shape/detail 在一代云场内不可变；随天气时间更新的 bands/occupancy 使用双缓冲、同一时间戳原子交换，禁止一帧混用新 bands 与旧 occupancy。
- 冷生成、缓存命中、取消、切星、设备丢失(GLSL 链为 `webglcontextlost/restored`)与 dispose 都要有测试/遥测；上传单帧额外预算 ≤ 4 ms，实测不达标就切片上传(WebGL2 用 `texSubImage3D` 分片)。

**用户对本阶段的总要求**：画质优先（R1），目标 AAA 写实；性能在保证写实的前提下优化（阶段 7 才正式调性能）。本地 `HPVolumeCloud-main` 是无 `.git` 历史/远端可核验的 MIT 参考包，形态代码可作候选，但不能称为已验证成熟上游；任何光照公式都必须经过来源、量纲、能量和参考图像闸门，绝不是“唯一转换 HLSL→GLSL”。

---

## 1. 光照架构（2026-08-09 来源复审：生产基线 + 实验候选）

方向性单次散射与经验证的多阶近似组成生产基线；phi_fwd 只保留为实验候选。推导与来源边界见主文档 §8.4。

| 项 | 负责的现象 | 实施 |
|---|---|---|
| 1. 方向性散射（生产基线） | 银边、太阳方向感、稀薄边缘 | 双叶 Henyey-Greenstein；powder 只在参考 A/B 证明改善且不增能时启用 |
| 2. 多八度 Beer/相位近似（生产基线候选） | 用递减消光/贡献/偏心率近似高阶散射 | `attFactor=a^o`、`conFactor=b^o`、`gFactor=c^o`；来源记为 Frostbite 2016 云课程一类工程近似，不再误称 Hillaire 2020 大气论文公式 |
| 3. 加性 **phi_fwd（实验候选，默认关）** | 尝试补厚云内部/底部的漫射能量 | 只有参考积分证明优于第 2 项且无双重计能才启用；否则删除 |

**来源复审结论**：知乎闭式解继续只作历史存档；本地 HanPi 的 phi_fwd 从扩散方程出发有合理直觉，但把 3D 格林卷积压成单条太阳射线的 1D 和，再乘边界置信度、强度与压缩，已经是经验模型，不能宣称严格物理或能量守恒。`ω₀→1` 的数值稳定教训仍有效，但 clamp 只能防 NaN/爆亮，不能证明公式正确。

### 1.1 phi_fwd 实验协议（非默认实施路径）

```
κ = σ_t · √(3(1−ω₀))          # 漫射场衰减率，ω₀≈0.999 ⇒ 比 Beer-Lambert 慢 ~18×
Q_eff = T_abs · σ_sΔs · σ_tr · C_iso   # 有效源项四因子
  T_abs = exp(−(1−ω₀)·OD)      # 无逃逸漫射源的吸收存活率（不是单次透射率！）
  C_iso = 1 − exp(−τ_iso)      # 各向同性建立权重，τ_iso ≈ (1−g)·τ —— 刚入云方向记忆仍强
B_eff = C_top · C_bottom       # 边界置信度
  C_top:    2D 云顶高度代理差分出边界法线，对太阳方向 wrap 光照（防背光侧错误打亮）
  C_bottom: 1 − exp(−h_local/H_soft·p)，H_soft 随云柱厚度放大 1→4 倍
薄边缘门控：扩散近似只在 τ≫1 成立，低密度区密度门控（稀薄边缘该灰不该白，各向异性主导）
```

若进入实验，源项可与自阴影共用太阳方向样本以控制成本，但必须先做：① 均匀 slab 与球状密度的高样本 CPU/path-traced 参考；② τ、太阳角、g、ω₀ 参数扫；③ 反射/透射/吸收总能量界；④ 与多八度近似单独及叠加 A/B。叠加若重复补偿同一高阶能量，保留误差更小的一项，不得为了“层次更丰富”双算。

### 1.2 自阴影锥形 march 工程参数（§8.2 结论 5，直接照用）

几何级数步长：相邻步比率 2.0，首步 ≥ 5 m，总覆盖 ≤ 6000 m（再远密度≈0 纯属浪费）；反解首步宽度使 N 步正好覆盖总距离——**加步数 = 加近处精度而非加覆盖**。逐步 mip 偏移 `j/(N−1)·3`。

### 1.3 高空薄云独立光照路径（§8.2 结论 6，直接照用）

卷云族（wispy/veil 形态）单独一条路径：均匀步进、不采 3D 噪声、光程限 3 km——薄层不值得锥形采样。

---

## 2. HPVolumeCloud 形态子系统落地映射

> 来源：`D:\Eray0\Documents\_GitRES\Game\建议参考的优质项目\大气与体积云参考\HPVolumeCloud-main\VolumetricClouds.hlsl`（本地 MIT 包，无可核验 `.git` 上游）。**边界：只把密度成形当候选并逐项 A/B；光照不直接抄。** HP 是 weather map + 美术参数管线，我们的权威是天气系统 + 云种表。

| HP 子系统 | 是什么 | 落地到 |
|---|---|---|
| **高空云 UV warp**（`_HP_HiCellWarpTex` + `_HP_HiWispTex`） | 卷云纤维感的关键：采样 cell 噪声**前先用一张 warp 纹理扰动 UV**，把胞状噪声拉成丝；再叠云絮纹理 | 高云族（wispy/veil 形态）的密度求值加 warp 通道：shape 纹理的 worley 车道采样前用 fbm 低频车道扰动 (east,north) 坐标，warp 强度进 `MORPHOLOGY_PARAMS`。不需要新纹理，复用现有烘焙车道 |
| **SC 细胞厚薄曲线**（`_HP_ScCellThickPow`/`ThickStr`） | 层积云胞**中心厚、胞边界薄**（pow 曲线调制密度/厚度） | CELLULAR 形态加 cellThick 参数：worley 值过 pow 曲线后再乘进 density。现在我们的胞厚薄均匀，一眼假 |
| **BottomSmooth**（`_HP_BottomSmoothHeight`/`Pow`） | 云底软化（底部 N 米内密度 pow 渐出） | 所有低云族的 `VERTICAL_PROFILES` 底部段。现在 profile 底部 smoothstep 窗口是拍的，换成 HP 的 height+pow 形式并进形态参数 |
| **LoCoverTop**（`_HP_LoCoverTop*`） | coverage 高时**云顶压扁**（高度压缩最大倍率 + pow 曲线）——层积云大爆发的真实形态 | 低云族密度求值：band.top 按 coverage 压缩，C4 反同质化 |
| **分云种侵蚀强度**（`_HP_DetailStrengthCu/Tcu/Cb`） | 淡积云/浓积云/积雨云各自的细节侵蚀 | `MORPHOLOGY_PARAMS.erosion` 已有等价物，按 HP 的相对关系校准 CAULIFLOWER/TOWER 的取值 |
| **高空云独立光照** | 见 §1.3 | ~~cloud-volume-node.js~~(已删除)→ `clouds-webgl.js` 高云族分支 |

**不在本轮抄的**：`_HP_WeatherMap*`（它的天气图是美术刷的，我们的天气体系更强）、`_HP_Billowy/WispyLowStr/HighStr` 全局强度旋钮（我们的形态参数已覆盖）。

---

## 3. 体积 march 结构（原 TSL 载体,已停牌;GLSL 转换对照见顶部横幅）

原方案为新文件 `src/cloud/cloud-volume-node.js` 接线 `node-render-pipeline.js` 体积 pass——**两者均已随 WebGPU 线删除**。GLSL 链等价落法:在 `clouds-webgl.js`(或新 `cloud-volume-webgl.js`)的 `ShaderMaterial` 中实现 march,接线 `legacy-render-pipeline.js` 体积 pass。以下结构设计本身与后端无关,继续有效:

1. **射线参数化**：相机出发，行星相对坐标（复用 temporal-resolve 的相机相对约定，避免 fp32 大坐标）。
2. **求交与裁剪**：球壳求交 → `clipRayToOccupancy` 等价物的 GPU 版。占用体作为 3D 纹理上传，GPU 侧 DDA 走格子。注意 CPU 版是精确解析求交，GPU 版可以用固定小步长走格（占用格 ~295km×440m，走格成本可忽略），但必须同样**最近体素查找**（skip 决策不插值，这是 C1 保守方向）。
3. **段内 march**：按 `planRayMarch` 的逐段步长；密度采样调 GPU 采样函数(原 `cloudDensityTSL()`,GLSL 链按载体转换对照重写)。先以 /5 安全档运行，再做 4/6/8/12 samples-per-feature 收敛阶梯；正式质量档必须与下一高档在四场景、多种子运动序列中无实质可见收益，不能因为“≥4”就停止。
4. **光照**：每采样点一次太阳方向 march（§1.1/§1.2 合并路径）+ 三项叠加（§1）。
5. **合成**：与大气共享深度/辐射度约定与最终合成，但不共享 march 或低分辨率轮廓源缓冲（大气是阶段 5 的事）；输出直通 alpha，不二次预乘。
6. **时域**：本阶段不打开 history 或帧序 jitter；默认用每占用段的中点/确定性求积。任何空间 hash 都是需要运动 A/B 的候选，不是必选。运动向量、TAA 与体积 history 统一留给阶段 7。
7. **深度**：~~`volume-depth-node.js` 的 `sceneRayLimit`~~(已删除;GLSL 链用 `legacy-render-pipeline.js` 的 depth texture 做同一截断)截断不透明遮挡；地形遮挡由它管，占用体的 terrain 列只是 clip 加速器。

**地球阴影/日食**：太阳方向 march 的光源可见度接入现有日食系统（astronomy.js 的 eclipse 数据在 main.js 已有接线）。

**关于时域累积的定位修订（2026-08-09）**：高单帧采样可以在无 history 下稳定，但参考实现的步数不能证明本项目“每特征 4 样本”已足够。阶段 4 用确定性单帧求积并通过 4/6/8/12 收敛阶梯选择质量档；阶段 7 必做统一 TAA，体积 history 的采样摊薄只有在光流补偿连续运动、拒绝与拖影验证都通过后才启用。

**参考实现可借鉴的其他点**（分析于 2026-08-06）：
- 双叶 HG（g=0.35/−0.15 对半混合 ×2.2）—— 与 §1 第 1 项同族，可作参数 sanity check
- 3 八度 Beer/相位近似（`a + b·0.55 + c·0.25` 等）—— 只作 Frostbite/本地实现参数 sanity check，必须由本项目参考积分重标定
- light march 5 步几何级数（首步 140 m × 1.6）—— 与 §1.2 锥形参数互相印证
- aerial perspective：远云按距离混入天空雾（`fade = clamp(tStart/260km, 0, 0.7)`）—— S3/S4 远景云融入大气的廉价做法
- 云种调制：一条 weather 纹理的 G 通道做云种 typeN 插值 —— 我们的云种表更强，不抄这个

---

## 4. 独立视觉找茬与实机验收协议

> **为什么需要它**：阶段 4 的失败模式包含“看起来不对”，headless 数值测不出来。独立评审用于暴露盲点，但不以模型猜错参考图作为完成证明；最终主闸门是五维质量清单、多条件稳定性和用户实机验收。
> **目标图**：`docs/visual-targets/星际公民_目标比对/` 三张——`星际公民_远眺.png`（S4 全球晨昏线）、`星际公民_太空云层.jpeg`（S3 低轨逆光）、`体积云_云海之上.png`（S2 云上平飞）。S1 无目标图，用照片盲测（§4.4）。

### 4.1 场景-机位-目标图对应

| 场景 | 目标图 | 机位定义（行星半径 R=6000 km） |
|---|---|---|
| S4 全球远眺 | 星际公民_远眺.png | 相机距地心 ~2.2R，看向地心；太阳在画面右侧低角度，晨昏线斜穿画面（目标图从左上到右下）；昼半球占画面 ~2/3 |
| S3 低轨太空 | 星际公民_太空云层.jpeg | 相机高度 ~400 km，视线接近水平略下俯（地平线弧形占画面下半）；太阳在画面上方正中附近（逆光），云海延伸到地平线，大气蓝边可见 |
| S2 云海之上 | 体积云_云海之上.png | 相机在云顶上方 ~1.5 km 平飞视角，视线水平略下俯；近处云絮清晰、远处融入大气雾 |
| S1 地面看天 | （无目标图，照片盲测） | 地面站立，仰角 ~45°，**画面不含地面**（只有天空与云） |

机位实现在 `tools/cloudvisualdiag.js`（本阶段重写它），太阳方位必须可参数化以匹配目标图光照方向。截图前用 Playwright 无头跑真实游戏，与 `npm run shots` 同一套基建。

### 4.2 找茬轮（指导修改）

每轮把**本项目截图 + 对应目标图**交给独立评审，prompt 模板：

```
你是苛刻的 AAA 游戏画质评审。图 A 是某太空游戏的实时渲染截图，图 B 是《星际公民》的
参考画面。两者是相同场景类型（{场景描述}）。只评估云的渲染质量，不评估构图差异、
云分布内容差异、飞船/地形等前景内容。按以下五个维度逐项对比图 A 与图 B 的差距：
1. 形态结构：云的团块/云絮/胞状结构是否自然，有无程序感（重复、规则、不该有的锐利边缘）
2. 体积感：云是三维的团还是二维的贴片，厚度与层次
3. 光照：亮暗面与太阳方向的一致性、银边、明暗过渡是否物理
4. 色彩与融合：云的白平衡、云与大气雾/天空的过渡
5. 尺度感与体系：云的大小与分布是否符合行星尺度（大片云区与大片晴空的组织）
输出：按维度列出图 A 的具体缺陷清单，每条注明严重度（致命/明显/细微）。
若某维度图 A 已达到或超过图 B，明确说"达标"。禁止客套。
```

### 4.3 盲评轮（辅助证据，不是硬指标）

找茬清单清空（或只剩"内容差异"）后进入盲评。**AB 顺序随机**（主 agent 抛硬币，不在 prompt 里泄露），prompt：

```
这是两张太空游戏截图，一张来自《星际公民》，一张来自另一个项目。场景类型相同
（{场景描述}）。哪张是星际公民？先分别描述两张图云的特征，再给出判断和置信度。
```

猜错可作为“接近参考质量”的弱证据；猜对不自动失败，但其判断理由必须转成可复核缺陷。场景通过要求五维清单无致命/明显缺陷、跨种子与光照复验稳定，并由用户实机确认。

### 4.4 S1 照片盲测（地面视角）

S1 没有目标图。截图（地面仰角、无地面入镜）单独交给独立评审：

```
这是一张天空的照片或游戏截图。判断：这是现实照片还是游戏渲染？
给出判断、置信度，以及支持你判断的全部细节依据。
```

“现实照片/游戏”判断只作辅助；所有可复现的露馅细节（云底非物理死黑、边缘程序感、重复纹理、尺度错误）进入修改清单。S1 仍由用户实机仰视与穿云体验验收。

### 4.5 循环与终止

```
改参数/着色器 → 截图（四机位）→ 找茬轮（S2/S3/S4 各一）→ 清单为空？
  → 否：按清单改，回到截图
  → 是：辅助盲评 → 理由转找茬清单 → 多种子/光照复验 → 用户实机验收
S1 并行跑照片盲测。
```

- 每轮迭代在主文档 §7 记录轮次、场景、种子/时刻、找茬条数与修复摘要。
- **防客套**：评审的“达标”声明本身不算证据，必须对应五维清单、截图和可复现实机状态。
- **防过拟合单张截图**：每个场景通过盲评后，换一个天气种子/时刻再截一张复验一次（云是程序化的，不能只对一棵树达标）。
- 数值闸门每轮照常跑：有限/非负介质、云区亮度与 alpha 分位数、最终光学覆盖、`npm test`、静止与连续扫镜。真实深阴影允许存在；禁止的是采样洞、NaN 或预乘错误造成的死黑块。

### 4.6 评估协议存档

本节（§4）的 prompt 模板同步存一份到 `docs/visual-targets/星际公民_目标比对/README.md`，截图机位参数以 `tools/cloudvisualdiag.js` 为准——上下文压缩后任何会话读这两个文件就能继续跑循环。

---

## 5. 实施步骤（复选框，按顺序勾）

> **[2026-08-15 停牌注]** A 组复选框的"完成"指**已删除的 WebGPU/TSL 线**上的历史完成(证据见 §6 与 git 历史),其载体文件(`cloud-volume-node.js` 等)已不在工作树;B/C/D 从未开工,且不得按 TSL 载体开工——若在 GLSL 链重新实施写实体积云,按顶部载体转换对照重写后,以 `optimization-roadmap.md` 批次 B 的验收标准重新走闸门,不得沿用本表勾选状态。

**A. 基建与 march 骨架**(已完成于已删除的 WebGPU 线,存档)
- [x] A0 云场 worker/token/cache/upload/dispose 生命周期与每行星 CPU/GPU 字节遥测落地；bands/occupancy 原子双缓冲；切星/取消/设备丢失测试通过
- [x] A1 重写 `tools/cloudvisualdiag.js`：按 §4.1 四机位、多种子/时刻截图（太阳方位可参数化）
- [x] A2 ~~`cloudDensityTSL()`~~(TSL 实现已删)落地；真实 WebGPU 固定切片 + 随机点 readback 与 CPU 介质误差 < 1%，不是只跑 fp32 CPU 仿真
- [x] A3 GPU 占用体 DDA + 段内 march 骨架（单散射、无光照）；4/6/8/12 采样收敛阶梯记录，四机位能认出体积结构

**A 阶段边界（2026-08-10）**：当前是确定性、无 history/frame jitter 的 Beer 消光 + 无方向光占位辐亮度骨架；截图能看到 S1–S4 的占用高度带、壳内厚度与空间分布，但平灰厚云、硬轮廓和近场块感仍明显。它们是 B 光照与 C 形态的开放项，**A 的完成不等于五维画质评审通过，更不等于阶段 4 完成**。近场 S1/S2 的 8→12 档仍有可见差异，最终质量档保持开放；S3/S4 已基本收敛。

**B. 光照（§1 生产基线与实验协议）**
- [ ] B1 方向性散射：双叶 HG；powder 单独 A/B 并证明不违反能量界后才启用
- [ ] B2 锥形自阴影 march（§1.2 参数）+ 地球阴影/日食接入
- [ ] B3 多八度 Beer/相位近似；与均匀 slab/球状云高样本参考比较并标定总能量
- [ ] B4 **可选实验** phi_fwd（§1.1）：只有相对 B3 明显降误差且叠加不双重计能才保留，否则删除
- [ ] B5 高空薄云独立路径（§1.3）
- [ ] B6 march 默认占用段中点/确定性求积；若尝试空间 hash/蓝噪声，必须与无 hash 基线做光流补偿运动 A/B，残差不升才可保留；禁止 frame 项

**E. 阶段 7 追踪项（不属于阶段 4 完成条件）**
- 统一全屏 TAA、运动向量与体积 history，替换失败的壳球局部累积器
- 连续大幅扫镜做光流/重投影补偿逐帧残差；静止 seamtest 0 px 不再是充分条件
- 在最终辐亮度分布上标定 history rejection，禁止按固定经验倍率拍阈值

**C. 形态子系统（§2 映射表）**
- [ ] C1 高云 UV warp（卷云纤维）
- [ ] C2 SC 细胞厚薄曲线
- [ ] C3 BottomSmooth 云底软化
- [ ] C4 LoCoverTop 云顶压扁
- [ ] C5 分云种侵蚀强度校准

**D. 验收**
- [ ] D1 数值闸门：`npm test`；GPU/CPU 一致性；最终光学覆盖；有限/非负介质；亮度/alpha 分位数；slab/球状云参考积分与能量界；静止与光流补偿连续扫镜；资源/上传预算
- [ ] D2 S1–S4 至少 3 种天气种子、昼/暮/夜五维评审无致命/明显缺陷；用户实机验收通过。盲评只保留为辅助证据
- [ ] D3 主文档 §7 勾阶段 3 GPU 闭环与阶段 4；记录质量档、性能、资源字节数、截图和用户验收结论

---

## 6. 验证记录

（每轮一行：日期、轮次、种子/时刻、S1–S4 找茬条数、辅助盲评、改动摘要、实机结论。阶段完成时汇总进主文档 §7。）

| 日期 | 轮次 | 内容 | 结果 |
|---|---|---|---|
| 2026-08-10 | A0 | `cloudresourcetest` + 三种子真实上传 | 生命周期、取消、设备丢失、原子交换和两帧释放通过；CPU 44.53 MiB / GPU 44.50 MiB；50 个上传切片，最慢 0.60 ms，0 次超过 4 ms |
| 2026-08-10 | A2 | NVIDIA Blackwell WebGPU 固定切片 1024 点 + 随机 512 点 | 固定切片密度最大误差 0.442%、消光 0.912%；随机点 0.292% / 0.437%，均 < 1% |
| 2026-08-10 | A1/A3 | `CLOUD-PHASE4-A/B/C` × 9.5/17.75/23.5 h × S1–S4；另跑 4/6/8/12 | 52 张截图、12 组相邻档 diff；无浏览器错误/设备丢失。8→12 mean RGB：S1 1.011、S2 2.588、S3 0.033、S4 0.219（/255）；近场质量档未定 |

完整机器可读记录：`test-results/cloud-gpu/report.json` 与 `test-results/cloud-phase4/manifest.json`。这些是实现证据，不替代 D2 五维目标图评审和用户实机验收。
