# WebGPU 迁移现状文档

> 本文档记录 WebGPU 渲染路径相对 WebGL 基线的对齐状态,作为长程迁移工作的持久参考。
> 每次 WebGPU 相关工作开始前应先读此文档,避免重复调研。
> 最后更新:2026-07-22(P0-3 抗锯齿 + P1-2 山谷雾已对齐)

## 背景与决策

- **用户要求**:WebGPU 路径任何地方都不能比 WebGL 差,一致性是硬性要求,决不允许"复杂代码迁移成简单劣质表达"。
- **当前状态**:WebGL 是产品基线([renderer-policy.js:9](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/renderer-policy.js#L9) `WEBGPU_PARITY_READY = false`),WebGPU 是 `?renderer=webgpu` 显式开启的实验路径。
- **迁移终局**:WebGPU 成为默认路径,且视觉质量全面对齐或超越 WebGL,最终翻 `WEBGPU_PARITY_READY = true`。
- **用户硬件**:Intel Xe-LPG GPU(实测 WebGPU 可用)。

## 架构路由

所有双实现子系统通过 `?renderer=webgpu` URL 参数统一分发:

| 入口 | WebGL 路径 | WebGPU 路径 |
|---|---|---|
| 主模块 | `import 'three'` | `import 'three/webgpu'` |
| Renderer | `THREE.WebGLRenderer` | `THREE.WebGPURenderer` |
| Pipeline | `GameLegacyPipeline`([legacy-render-pipeline.js](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/legacy-render-pipeline.js)) | `GameNodePipeline`([node-render-pipeline.js](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/node-render-pipeline.js)) |
| 地形/水/云材质 | [shaders-webgl.js](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/shaders-webgl.js) | [shaders-node.js](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/shaders-node.js) |
| 体积云 | [clouds-webgl.js](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/clouds-webgl.js) | [clouds-node.js](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/clouds-node.js) |
| 体积通道 | [volumetric-pass-webgl.js](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/volumetric-pass-webgl.js) | [volumetric-pass.js](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/volumetric-pass.js)(stub) |
| 气巨行星 | gas-giant-webgl.js | gas-giant-node.js |
| 黑洞 | black-hole-webgl.js | black-hole-node.js |
| 空间裂缝 | spatial-rift-webgl.js | spatial-rift-node.js |

路由 facade:[shaders.js:5](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/shaders.js#L5)、[clouds.js:5](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/clouds.js#L5) 等,顶层 `await import(?renderer=webgpu ? 'X-node.js' : 'X-webgl.js')`。

`quadtree.js` LOD 逻辑**无 renderer 分支**,两条路径完全一致。

## 已完成的对齐工作

| 项 | 状态 | 说明 |
|---|---|---|
| 地形中尺度八度(色调) | ✅ 已对齐 | [shaders-webgl.js](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/shaders-webgl.js) + [shaders-node.js](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/shaders-node.js) 两侧均移植上游 mid-scale patchiness |
| 地形法线弯曲(normalNode) | ✅ 已对齐 | [shaders-node.js:254-267](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/shaders-node.js#L254-L267) 新增 `material.normalNode`,项目首次使用,系数与 webgl 版一致(`1.7 + vMat.x * 1.5`) |
| 地形 roughness 微光泽 | ✅ 已对齐 | 两侧均 `+ gPatch * 0.14` |
| 抗锯齿(P0-3) | ✅ 已对齐 | [node-render-pipeline.js:29](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/node-render-pipeline.js#L29) 主场景 pass `samples:0 → 4`(MSAA)。体积层和前景层保持 0(半透明,MSAA 无意义) |
| 地形山谷雾(P1-2) | ✅ 已对齐 | [shaders-node.js:254-267](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/shaders-node.js#L254-L267) 新增山谷雾,用 `positionView.z` 做深度因子,逻辑与 WebGL `fog_fragment` 注入一致 |

## 降级点清单(按严重程度排序)

### P0 — 直接决定"体积云、观感不如 WebGL"的根因

#### P0-1. 体积云材质严重降级 ⏳ 待做

- **文件**:[clouds-node.js:85-186](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/clouds-node.js#L85-L186)
- **对照**:[clouds-webgl.js:100-391](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/clouds-webgl.js#L100-L391)
- **差异**:
  - 步数:WebGPU 固定 16 步(`Loop(16)` L130)vs WebGL 124 步自适应
  - 缺失 HG 相函数、背向相函数、粉末效应、银边(silver lining)
  - 缺失太阳行进(sun march,2-3 sample),仅一次 sun weather 采样
  - 光照模型:仅 `selfShadow × heightLight` 简单 mix(L157-161)vs WebGL 完整 Beer-Lambert + 相函数
  - `tSceneDepth` uniform 声明了但从未绑定(L98,`uDepthReady: 0`)
  - 缺失帧相位抖动(jitter)、地面球遮挡测试
- **影响**:云的光照、边缘银边、粉末效果、太阳散射全部缺失,云看起来扁平且光照错误

#### P0-2. 体积通道是 stub,无 TAA / 无边缘感知上采样 / 无深度 ⏳ 待做

- **文件**:[volumetric-pass.js:1-51](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/volumetric-pass.js#L1-L51)(stub)+ [node-render-pipeline.js:52-60](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/node-render-pipeline.js#L52-L60)
- **对照**:[volumetric-pass-webgl.js](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/volumetric-pass-webgl.js)(完整 TAA)
- **差异**:
  - stub 类无 `render` 方法,仅状态控制
  - `pass(depthBuffer: false)` + 简单 `over()` alpha-over 合成(L55、L59)
  - 无 TAA 重投影(球壳求交 + prevViewProjection + history ping-pong)
  - 无边缘感知上采样(alpha 相似度加权)
  - 无场景深度绑定,raymarch 不在地形/船体处终止
- **影响**:云边缘锯齿、云穿透地形/驾驶舱、半分辨率锯齿、时域闪烁

#### P0-3. 后处理无抗锯齿 ✅ 已对齐(2026-07-22)

- 主场景 pass `samples:0 → 4`(MSAA),体积层和前景层保持 0(半透明 MSAA 无意义)。

### P1 — 明显观感差异

#### P1-1. 3D 云噪声无 mipmap ⏳ 待做

- **文件**:[clouds-node.js:65-68](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/clouds-node.js#L65-L68)
- **对照**:[clouds-webgl.js:73-76](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/clouds-webgl.js#L73-L76)
- **差异**:`LinearFilter` + `generateMipmaps: false` vs `LinearMipmapLinearFilter`
- **原因**:r185 的 WebGPU mipmap 生成器把 3D 切片当数组层处理,生成无效 2D-array 视图,只能禁用(L62-64 注释)
- **影响**:远景云采样更噪、更闪烁

#### P1-2. 地形山谷雾缺失 ✅ 已对齐(2026-07-22)

- shaders-node.js applyTerrainDetail 新增山谷雾,用 `positionView.z` 做深度因子,逻辑与 WebGL `fog_fragment` 注入一致。

### P2 — 局部/轻微降级

#### P2-1. 远景树距离淡出缺失

- **文件**:[farflora.js:60-100](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/farflora.js#L60-L100)
- **差异**:WebGPU 分支仅高度缩放,丢 `uCamL` 距离淡出
- **影响**:远景树过渡更硬

#### P2-2. 低空云加密场缺失

- **文件**:[shaders-node.js:299-344](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/shaders-node.js#L299-L344) applyCloudField
- **差异**:无 `uSurfaceView` 双层混合(改用固定细侵蚀)
- **影响**:低空云带看起来更平

#### P2-3. 无 OutputPass 等价物

- **文件**:[node-render-pipeline.js](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/node-render-pipeline.js)
- **差异**:依赖 `renderer.outputColorSpace`,色彩管理路径不如 legacy 完整
- **影响**:可能存在微妙的色调映射差异

## 已对齐(无需再动)

- `quadtree.js` LOD 逻辑(无 renderer 分支)
- 大气层([planet.js:1147-1228](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/planet.js#L1147-L1228) TSL 移植忠实,Rayleigh+Mie 14 步)
- `applyWaterWaves` Fresnel + Beer-Lambert
- 黑洞(black-hole-node.js)
- 空间裂缝(spatial-rift-node.js,最完整 TSL 移植)
- SkyDome(effects.js 217-305 双分支对齐)
- scatter 风摆
- 地形法线弯曲、粗糙度调制、云阴影旋转

## WebGPU 更优(迁移时保留,不要回退)

- **气巨行星**([gas-giant-node.js](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/gas-giant-node.js)):程序化动画急流 `sin(lat·52 + t)` + `mx_fractal_noise` + 420 实例化环粒子 + 正确环缝
- **applyCloudField 等矩形 weather atlas**([shaders-node.js](file:///d:/Eray0/Documents/_GitRES/Game/深空/src/shaders-node.js)):比 WebGL 极地投影更稳,无 swim

## WebGL 基线参考截图

2026-07-22 用 `npm run shots`(SwiftShader WebGL)生成,seed=EUCLID:

| 场景 | 文件 | stats |
|---|---|---|
| 空间全景 | screenshots/webgl-baseline/01-space-vista.png | 148 draws, 1.11Mtri, 96 chunks |
| 低空飞行 | screenshots/webgl-baseline/04-low-flight.png | 149 draws, 1.66Mtri, 160 chunks |
| 地表 | screenshots/webgl-baseline/05-surface.png | 338 draws, 2.51Mtri, 196 chunks |
| 一致性远 | screenshots/webgl-baseline/07-consistency-far.png | 153 draws, 1.18Mtri, 96 chunks |
| 一致性近 | screenshots/webgl-baseline/07-consistency-near.png | 147 draws, 1.15Mtri, 96 chunks |

## 待办路线图

### 阶段一:视觉对齐(满足"不能比 WebGL 差"的底线)

1. ~~**P0-3 抗锯齿** — `pass()` 设 `samples:4` 开 MSAA。低风险,可立即做。~~ ✅ 2026-07-22 完成
2. ~~**P1-2 地形山谷雾** — TSL 版 applyTerrainDetail 补 `fog_fragment` 等价物。低风险。~~ ✅ 2026-07-22 完成
3. **P0-1 体积云材质对齐** — 把 HG 相函数、粉末、银边、太阳行进、124 步自适应翻译到 TSL。中风险,工作量大。
4. **P1-1 3D 噪声 mipmap** — 调查 r185 WebGPU 3D mipmap bug 是否已修复,或用 compute 生成 mipmap。需验证。
5. **P0-2 体积通道 TAA** — 最大难点。需验证 three.js `RenderPipeline` 能否支持跨帧双缓冲 + 球壳重投影。先写可行性原型,通过后再完整体实现。
6. P2 项逐一补齐。
7. 跑 `npm run shots` 对比验证,翻 `WEBGPU_PARITY_READY = true`。

### 阶段二:性能跃迁(拿到 WebGPU 真实优势,在视觉对齐之后)

- indirect draw 合并 quadtree chunk(1000+ draw call → 个位数)
- compute 做 GPU-side LOD 选择 / morph / scatter 安放
- storage buffer 让 height/biome 函数完全在 GPU 查表
- **当前 compute/storage/indirect 全部零使用**,node pipeline 只换了表达方式

## 技术验证记录

- 2026-07-22:`material.normalNode` + TSL `.cross()`/`vec3()` 在 WebGPU 编译运行成功,无 shader 错误,行星和地形正常渲染。
- 2026-07-22:`npm test` + `npm run test:terrain` 全过,锁指纹 `8dfbd83a...` 不变(地形中尺度八度 + normalNode 移植后)。
- 2026-07-22:MSAA `samples:4` + `positionView` TSL 节点在 nvidia blackwell WebGPU 编译运行成功。控制台干净(仅 powerPreference/Clock 弃用警告)。168 chunks / 1.4Mtri 正常渲染。
- WebGPU 路径已知运行时警告:swapchain 尺寸相关 WebGPU 验证错误(非 shader 问题)。

## 关键约束

- 每次修改后必须跑 `npm test`(验证模块解析 + 锁指纹)和 `npm run test:terrain`(验证地形)。
- WebGL 路径是基线,WebGPU 修改**不得**影响 WebGL 路径。
- 涉及 `shaders-node.js` 的 TSL 变更,`npm test` 只做模块解析,实际 TSL 编译要浏览器 `?renderer=webgpu` 实测验证。
- 上游 NoMansSkyThreeJS 仓库的体积云实现可作参考,但我们的 WebGL 版已经比上游更复杂(124 步 + 完整相函数),应对齐的是我们自己的 WebGL 版。
