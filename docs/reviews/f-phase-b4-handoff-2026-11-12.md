# F 阶段底层收官 → Fable B4 云专项恢复交接说明

日期：2026-11-12  
前置断点：[2026-10-07 云返工暂停断点](cloud-rework-checkpoint-2026-10-07.md)  
底层证据：[F 阶段收官基线](../baselines/foundation-phase-f-2026-11-12/README.md)

## 1. 底层已就绪能力（无需在 B4 重复建设）

1. **默认原生 2K 生产路径已打通**：
   - `src/main.js` 默认启用远云程序拆分（`?cloudsplit=0` 可关）、异步云程序准备（`?cloudprograms=0` 可关）与近云分批照明（`?cloudbatches=0` 可关，默认 `budgetBytes = 32 MiB`、分片剔除模式 `fusedDensity = false`）。
   - 默认 `2560×1440` 冷启动约 `28.5–30.1 s`，`200 km` 远近云切换等待 `0 ms`、最大帧间隔 `93.2 ms`（已在轨道后台完成 GLSL 链接 + `1×1` scissor D3D11 MRT/实例化预热，并在 `> 250 km` 自动释放 26 MiB 暂存页）。
2. **近/远云四场照明与合成预算已压入实时帧内**：
   - `lowflight-2k`（`1178×662` 体积目标）分批照明暖态 GPU 中位数 **`13.74 ms`**，全效果近水 `2560×1440` 实飞达 **`37.2 FPS`**。
   - `CloudLightBank` 已修复实时时钟窗口饥饿（生产管线 `interval = 0.1 h`、`lazyBootstrap = true`、高空云底跨度扩展至 `23,040 m` 并持有 `weatherStream` 预报租约），近场缓存命中率稳定。
   - 缓存外远切线自动启用 **4 关键帧光程跨距插值**（`bin = 0, 5, 10, 15`）与 **5 子段单调空气传输**，`R32F` 与单片参考逐像素一致（`maximumError = 0`）。
3. **跨消费者光学与时域接口已合流**：
   - **云代表深度与风切变平流**：`VolumetricPass.repDepth`（`RGBA32F`：`repT, spreadT, firstT, lastT`）与 `RenderFrameState.mapWeatherAdvection()` 已接入低/中/高三层（`1.0× / 1.25× / 1.65×`）风平流重投影；可选全场景 `?taa=1`（`NMS.setTemporalAA(true)`，2K 耗时 `0.38 ms`）已打通刚体飞船、波浪变形与混层反遮挡。
   - **地表/水面共同消费者**：`CloudSurfaceShadowPass` 带保守屏幕球裁剪与纯深度预通（`uSurfaceDepthOnly`）；`surface-atmosphere.js` 提供法线方向性天空辐射度、`1.4–16.5 km` 宏观地形遮挡及共用 `AtmospherePass` LUT + 视差云壳的物理水面反射（`surfaceWaterReflectedSky`）。

## 2. Fable 开展 B4 首族返工的关键护栏（必读）

1. **编译时间与寄存器（VGPR）红线**：
   - D3D11 FXC 对每个 `cloudExtinctionAt` / `productionCloudDensity` 调用点都会完整内联全部云种噪声循环。**严禁在同一 shader 阶段新增第二个未裁剪的密度/光程调用点，也不要写常量小上界包裹大核的 `for` 循环**（FXC 展开后会把 VGPR 推过 64–128 悬崖，帧耗时瞬间劣化 3～5 倍）。
   - 修改 `src/clouds-webgl.js` 时，保持 `src/cloud/cloud-far-split-shaders.js` 与 `src/cloud/cloud-light-query-glsl.js` 的锚点匹配，改动后立即运行 `node tools/cloudfarsplitcompiletest.js` 与 `node tools/cloudlightbatchcompiletest.js`（各约 5 秒），确保全部 11 个远云阶段与 6 个近云分批阶段零编译错误。
2. **现有逐字符契约测试提示**：
   - `tools/columncondensatetest.js` 对 `src/cloud/production-shape.js`（`productionSpeciesGLSL`）与 `src/cloud/production-medium-glsl.js`（`productionCloudGLSL`）有逐字符稳定性断言。B4 有意重写第一族层积云形态/侵蚀 profile 时，须同步更新 `columncondensatetest.js`、CPU `sampleProductionMedium` 与对应光学回归，切勿只改 GPU 单侧导致云锚点/高度探测失配。
3. **B5 有序传输不变量**：
   - 体积输出仍为对全分辨率 `Bair` 的线性 HDR 修正 `vec4(correction * uEngage, alpha)`（允许负通道以抵消被厚云遮挡的后方空气散射，严禁在 `VolumetricPass` 内将 `correction` 钳制到 `[0, 1]` 或按相机曝光裁剪白色上限）。每次调整消光或多次散射后运行 `node tools/b5transporttest.js` 与 `node tools/b4lightcontinuitytest.js`。

## 3. 建议 Fable 直接切入的 B4 起点

1. 从 `B4-04 / B4-08～10`（层积云首族完整成像）切入：围绕母星海岸/海洋与草地机位，打磨层积云胞状密度、自然破碎边缘、孔隙连通性与银边/自阴影层次，消除早期灰膜感与块状边缘。
2. 在调参时直接使用原生 2K 真实页面（`http://127.0.0.1:8000/?quality=balanced&nohero=1&nolock=1&taa=1`）配合 `NMS.coast(0, 380)`、`NMS.teleport`、`NMS.setLocalSunAltitude(0, 12)` 同时观察 **主视图近远云、地表云影、物理水面云影/视差反射** 四处的一致性（对应 `B4-05`）。
