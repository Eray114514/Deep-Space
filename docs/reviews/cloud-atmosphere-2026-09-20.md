# 批次 B 审查：2026-09-20

审查基准：`294c204d5618d62b5c76e65ae139e4b3608684aa` 的生产源码，WebGL2。本页保留当时发现，审查轮仅改文档；**之后已实施的修复与尚未关闭的部分见[巩固交接](cloud-atmosphere-foundation-2026-09-20.md)**，不要把下面的旧实现描述当作当前状态。审查覆盖 docs 全部 Markdown，并核查 B 的生产接线、测试断言、历史报告与硬件截图。

**判断：现有基础值得保留，但不能按旧完成结论直接向后堆功能。** CPU 天气/云种/占用体有用；独立全分辨率大气和 opaque depth 接线也有用。需要返工的是大气数值积分与空间合成、部分云介质定义，以及将天气真正贯通所有消费者的路径。不是整包推倒，也不是仅补几项参数。

## 1. 需要返工的实现与验收

### P1：大气“积分收敛/物理完成”没有成立

代码：[`atmosphere-pass-webgl.js`](../../src/atmosphere-pass-webgl.js)，`VIEW_STEPS = 20`、`LUT_STEPS = 48`。生产视线仍把整段路径均分为 20 份，与旧文“按尺度控制、不均摊固定步数”的完成说明矛盾。

本次对 100 km 垂直气柱的指数密度做独立解析比较，`H` 为尺度高度，真值为 `H*(1-exp(-100000/H))`。视线使用生产同式中点求积；LUT 值来自实际 `createAtmosphereOpticalDepthLut()` 的地表、太阳天顶 texel（默认 256×96、48 步）。

| 密度分量 | 解析积分 | 20 步视线积分 | 相对误差 | 实际 LUT 积分 | 相对误差 |
|---|---:|---:|---:|---:|---:|
| Rayleigh，H=8000 m | 7999.9702 m | 7871.2307 m | −1.609% | 7977.4094 m | −0.282% |
| Mie，H=1200 m | 1200 m | 632.3766 m | **−47.302%** | 1061.5673 m | **−11.536%** |

这是**密度路径积分误差，不是最终 RGB 误差**；它已足以否定“当前积分精度经证明受控”。它不说明每条切线都同样差，也不直接规定必须增加到多少步。修复须分别验证视线、LUT/插值与最终散射误差，再选择分段/非均匀采样、LUT 或其他方案。

复现方法：在仓库根以 Node ES module 导入上述生产函数，用 `atmosphereRenderProfile({R:6000000,hAmp:12000,atmoDensity:1,atmosphere:{pressureBar:1},weatherProfile:{temperatureK:286}})` 建 profile；读默认 LUT 的 `(y=0,x=255)`，R/G 通道分别乘 8000/1200；20 步中点和解析式按上式计算。无需浏览器，也不依赖旧报告。

此外，最终 shader 仍用 `discWeight=0.008+…`、`discExtinctionWeight=0.018+…`、独立外缘散射/消光权重及观察高度曝光修形，经验间接光也没有参考误差验证。这可以被称作已经改善外观的混合模型，不能称为已验证的完整物理散射。与 R 的曝光职责须收口，不能继续用视角补丁解决积分或重复照明错误。

**关闭条件：** 独立参考积分/图像误差、多 profile/光照/高度通过，艺术控制与物理量分开；保留现有全分辨率深度基础及已消除蓝壳的改善。

### P1：云与空气不是按实际空间路径合成

代码：[`legacy-render-pipeline.js`](../../src/legacy-render-pipeline.js) 顺序为 opaque → atmosphere → clouds；[`volumetric-pass-webgl.js`](../../src/volumetric-pass-webgl.js) 最后使用 `volume.rgb + base.rgb*(1-volume.a)`。[`clouds-webgl.js`](../../src/clouds-webgl.js) 输出没有读取从相机到云的空气透射/散射。

依据这些接线，当前云覆盖在已经积完大气的背景上。半透明云会按云 alpha 压掉背景中的空气贡献，而云辐射本身未正确经过前方空气。这是生产链的结构缺口；共享 opaque depth 只能保证几何遮挡，不能证明远云空气透视、云内/外重叠介质正确。仅交换两个 pass 顺序也不能一般性解决交叠。

**关闭条件：** 定义各段路径 `L/T`，以单团云、薄层、厚云与云前/后几何验证，再回 S1–S4；保留独立 march，但给合成明确的距离/透射接口。

### P1：天气和云种的 CPU 完成没有成为生产天气

代码：[`planet.js`](../../src/planet.js) 的 `weatherAt()` 调 `sampleWeatherField()`；`ensureCloudResources()` 要求 `volCloudState.rewrite === 'phase4-A'`，当前 WebGL 云没有该状态。新 `weather-system.js`、云种 bands 与 `cloudMediumCPU()` 没有被当前云 shader 消费；生产云还使用自身的 `weatherSystem()`/密度函数。不能把新天气代理的 50% 覆盖或 16 云种权重当作当前画面。

`planet.js` 把全局云底约束在 12–22 km，依据整星 `hAmp` 而非局地 LCL；现有云内 profile 有变化，但不等于落实了区域天气决定的云底和多云种高度。

**关闭条件：** 先让一个天气场贯通云、影、水面、降水/雾和玩法，再扩云种；最终用生产介质透射核查 C5。CPU 模型保留，不必为架构形式整套搬入旧 3D 纹理资产。

### P1：部分云定义随相机改变；全食仍保留直射

`clouds-webgl.js` 的 `renderOuterRadius()` 在近处把厚度压到 45 km，220–1600 km 相机高度间再展开；`densityAt()` 用此半径归一化高度，`sigma=3.80/thick` 也随之改变。**仅厚度大于 45 km 才触发**，不能泛称当前母星也在变化：本次生产母星实测厚 41.56 km，分支不触发。生成公式可到 56 km，authored top 也允许更厚，结构仍须修。

可直接核对的反例：底 12 km、厚 56 km，同一世界点高度 40 km，在近景归一高度为 `28/45≈0.6222`，远景为 `28/56=0.5`，随后进入云底/顶 profile 与噪声坐标。世界几何与消光随观察者变，不能作为一致性 LOD。此处结论来自代码代数；本轮隔离 GPU 密度读回探针得到全零、未建立有效非空样本，**已排除为验收证据**，没有把 0 差分称为通过。

同文件的 `cloudEclipseLight=mix(0.35,1.0,eclipseLight)` 明确保留 35% 直射；体积云只有一组 `uSunDir/uSunC/uSunEnergy`，与大气两组逐星输入不同。旧“云/大气/地表双星日食已一致”说法过强。真实环境光可照亮全食云，但不能归到未被遮挡的直接光束。

**关闭条件：** 相机独立密度/消光、质量档的误差受控表示；逐星直射与间接散射分开；厚薄包络、全食及交换双星主次均有测试。

### P2：资源、运动测试的证明范围被写大

- [`cloudresourcetest.js`](../../tools/cloudresourcetest.js) 注入模拟 upload；[`cloud-resource-manager.js`](../../src/cloud/cloud-resource-manager.js) 真正分片路径依赖 `renderer.backend.device.queue.writeTexture`，WebGL 分支每帧仍整纹理 `initTexture()`。取消/交换模型的测试有效，但不证明 WebGL 上传 ≤4 ms。
- [`atmosphere-pass-webgl.js`](../../src/atmosphere-pass-webgl.js) 的 `profileCache` 虽为 WeakMap，`lutTextures` Set 强持有纹理，切星不逐项释放，仅 pipeline dispose 时全部释放。反复访问新行星存在缓存增长风险，须加实际切星循环/平台值测试；本轮未做显存泄漏实测。
- [`atmospheremotiondiag.js`](../../tools/atmospheremotiondiag.js) 自己已注明：同姿态回访只证明确定性，邻帧差未做光流补偿，未评价亚像素轮廓。旧 <0.086 RGB/255 不能证明连续大幅扫镜完成；其中 GPUDevice 事件钩子也不能覆盖 WebGL 原生上传事件。
- [`stagebatmospheretest.js`](../../tools/stagebatmospheretest.js) 的 `T + (1-T) = 1` 是恒等式，不是散射能量参考验证；LUT 有限/非负也不代表积分准确。
- [`cloudvisualdiag.js`](../../tools/cloudvisualdiag.js) 有真实 WebGL 运行与步数控制验证，但没有覆盖完整 S1–S4 × 多天气种子 × 昼暮夜；把云底强制 ≥8 km 的断言应随局地高度模型重写，不能保留为用户需求。

**关闭条件：** 各工具报告只声明其实际覆盖；补真实 WebGL 上传/释放、运动补偿、参考求积与坏例测试。阶段 7 的接口提前，最终优化验收后置。

## 2. 已完成部分如何处理

| 部分 | 处理 |
|---|---|
| 云种表、CPU 天气/密度/occupancy | 保留；CPU 通过状态不撤销，收窄为工具基础 |
| 独立全分辨率大气、opaque depth 传递 | 保留；有助于正确遮挡与清晰临边 |
| 当前 WebGL 云形态 | 保留作为艺术起点；不承诺冻结错误光程、相机依赖或直射保底 |
| 阶段 5 完整物理/最终合成完成勾选 | 撤回，按上述 P1 返工后重新验收 |
| 旧 WebGPU GPU 闭环、时域原型 | 历史，不恢复为待迁移必做项 |
| 三种盲评 PASS / 来源竞猜 | 只保留具体可定位缺陷价值，不作完成凭证 |

## 3. 本轮验证与视觉边界

- `npm test`：101 模块解析、配置、render look、四个云 CPU 闸门、天文、目录、工程合同通过；仅旧宇宙锁失败，未刷新。日志 `tmp/docs-audit-node.log`。
- `npm run test:stage-b`：大气参考/逐星辐射和旧天气合同通过。日志 `tmp/docs-audit-stage-b.log`。通过与上面的测试盲区同时成立。
- 系统 Chrome / RTX 5080 Laptop / WebGL2 / Ultra / post=1 / HUD 开启，捕获当前轨道、atmosphere-off 与近地仰视，浏览器错误 0。原图与报告在 `test-results/docs-b-audit-2026-09-20/`；临时审查脚本 `tmp/docs-b-audit.mjs`，**仅本机可用**。未宣称运行 full、完整动态或性能验收；取景时地形队列尚有构建，不用于重判 A。
- 当前正常轨道图可见云间晴空与细节，但主要呈分散絮块，尚不足以证明锋面/气旋等组织或具体云种可辨；近地仰视样本以大面积均匀蓝灰为主，不能证明 S1 的局地高度差。和目标图光照/构图不一致，因此只用于发现缺口，不作伪精确的 AAA 分数。
- 看过目标图后，不能用消掉蓝壳或“云确实渲染了”当作已经达到参考：体系、体积、侧切面、空气透视和连续穿越仍需完整样本。本轮结论是完成声明不成立及实现有明确缺口，不是替用户完成最终审美验收。

## 4. 文档计划本身的修订

删除重复 B 描述、废弃 TSL 施工清单、已被推翻的根因、逐轮日志和二手公式长篇抄录。保留 A 最终证据、C/D/E/R 产品要求、16 云种、S1–S4、C1–C5。修正旧行星半径、旧云包络、已存在的 `test:full`、选种截图命令与母星海平面微调。D 最终依赖加入 E。

取消“每 1 km 必须变化/五点不变就失败”与“盲评连续猜错才完成”，改为真实飞行耗时/视觉变化和五维缺陷评审；它们更直接对应用户目标，且不会诱导拉伸云壳或过拟合一张截图。

执行改为：**基线与空间合同 → 大气求积/合成修正 + 一族云天气闭环 → 扩展云种/特殊路径 → 持续跨消费者联调 → 统一 TAA/性能 → 用户实机验收**。没有删掉难项，也不强制重写已经有效的部分。

参考验证方法见 [Bruneton 公开实现](https://ebruneton.github.io/precomputed_atmospheric_scattering/)：它包含量纲检查、函数测试和 CPU 参考图比较。计划引用这一方法论，不以论文名字给现有实现背书。
