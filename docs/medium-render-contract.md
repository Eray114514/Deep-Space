# B 的介质、深度与时域接口

这是 B0 冻结、B5 落地和 F4 帧接口修订的**目标语义 v1.2**。B5 已提供分段空气与云/空气联合传输；2026-10-20 接入共同前后帧状态及云刚体映射，天气平流、占用深度和统一 TAA 仍为 B4/B7 目标，不要求预先分配所有纹理。状态与关闭条件只在[批次 B](cloud-atmosphere-rewrite.md)维护。

## 坐标、时间和单位

- 介质以 `galaxyId/systemId/bodyId`、场版本、独立生成种子定位；同一个行星局部米制位置和绝对天气时间应返回同一介质。相机相对坐标仅用于精度和投影，不能进入介质定义。
- 保留当前/上一帧行星位置与旋转、相机投影与姿态、相机相对原点；宇宙位置在 CPU 双精度保存。位置变换须同时计入行星自转、公转和原点重定位，不能把相机移动当作天气移动。
- 消光 `sigma_t.rgb` 单位 m⁻¹，散射系数满足 `0 ≤ sigma_s ≤ sigma_t`；相函数积分为 1，光源辐射使用统一线性 RGB。颜色风格与曝光不能偷偷改变物理透射。
- `absoluteWeatherHours` 与恒星时钟的关系须显式保存；天气平流必须可求前后时刻同一物质的位置。离散天气代际更新与连续平流分开，不把每帧时间变化都当作内容版本变化。

## 路径输出及合成

对归一射线 `p(t)=origin+t*direction`，`t` 为米。一个有序段 `[a,b]` 输出 `L.rgb`（从 a 看到的段内散射/发射）与 `T.rgb`（无量纲透射）。真空为 `L=0,T=1`；最终背景为 `L(0,D)+T(0,D)*surfaceRadiance`。

非重叠的前段 F 与后段 B：`L=Lf+Tf*Lb`，`T=Tf*Tb`，乘法逐通道。顺序不能交换。重叠空气/云必须在同一空间段合并消光与源项，或使用经参考验证的等价算法；把分别积完整条射线的两个结果直接叠加通常不成立。参考为 [PBRT 的透射定义](https://pbr-book.org/4ed/Volume_Scattering/Transmittance)及[传输方程](https://pbr-book.org/4ed/Light_Transport_II_Volume_Rendering/The_Equation_of_Transfer)。

| 逻辑信号 | 必须保留的语义 | 当前实现/迁移注意 |
|---|---|---|
| `opaqueRayDistance` + `opaqueValid` | 沿当前像素射线到首个不透明面的米制距离；天空单独标记 | RenderPass 写 Three logarithmic depth，解码 view-forward 后除射线前向余弦。AtmospherePass 在合成颜色时用 AlwaysDepth/gl_FragDepth 原样复制到输出附件，再交给 VolumePass；不能把采样附件同时绑定为写入目标 |
| `airTransfer(a,b)` | 指定段的 RGB L/T，裁至光学顶/地面/不透明深度 | `airIntegrate`/`mediumStep` 提供分段 L/T；全分辨率大气输出 `Bair=La+Ta*background`，无经验视角权重 |
| `cloudTransfer(a,b)` | 同一段内云的 L/T；不得丢失云前空气 | B5 RGBA 为对 Bair 的修正 C 与 `1-Tc`，不是单独的云辐射，也不是完整 RGB 介质透射。仅适用于灰消光云；有色云须扩展表示 |
| `cloudFirst/LastDistance`、代表距离/方差、valid | 云沿射线的占用范围；代表距离须说明权重，如 `Tprev*(1-Tsegment)` | 当前 history 只重投影到球壳半径。一个代表深度不是厚云分段合成的充分信息，不能因此删掉区间/误差界 |
| `radianceEncoding` | 未曝光线性 HDR 的 L；T 不受曝光影响 | 若为带预曝光实现，须带当前/上一帧预曝光因子并先还原再混 history；色调映射仅在最终显示链 |
| `contentEpoch`、`frameState` | 代际/坐标/时间与对应输出一致 | 新天气的纹理、占用体、参数不可跨代混用；异步上传只在同一代完整就绪后交换 |

上述是逻辑输出，B5 可选择 MRT、分层累积表、重算或其他表示，前提是受控场及正常玩家链误差通过。B0 不凭空锁定高显存布局，也不把单深度雾近似当作任意厚云的正确解。

B5 实际表示：设云区间前空气为 `(Lf,Tf)`，区间内联合空气/云为 `(Lj,Tj)`，同一区间纯空气为 `(La,Ta)`，灰云透射为 `Tc`。逐格合并消光和源项，计算 `C=Lf*(1-Tc)+Tf*(Lj-Tc*La)`，最终 `C+Tc*Bair`。云后空气已经在 Bair 中，代数消去后不会重复衰减。C 可以因空气散射被云阻挡而出现负通道，不能先 clamp 为零；它仍是线性 HDR 修正。改变源项/密度可沿用此表示，改变云消光为 RGB 则不能沿用标量 alpha。

## 场景深度与所有权

- 世界、地形、植被及停泊舱先贡献同一场景不透明深度；天空无命中时仍积分到介质边界。云不能把自身透明深度写回成不透明墙。
- B5 云 history 的深度附件保存采样位置的不透明深度，不是云深度；上采样先按深度匹配，再过滤云修正。细前景没有匹配的低分辨率样本时保留全分辨率 Bair，禁止借邻近天空云填入。
- 前景船体/武器使用独立层时，应明确其自身表面距离与接收介质规则；最后画前景只是现状，不证明雾/空气透视正确。
- 水面/玻璃的反射、折射和透射具有不同路径；不能仅凭主深度给它们重复套整段空气。B5 对前后几何、B6 对跨消费者反射分别提供证据。
- 门户/远端系统拥有独立世界原点、天气、深度和历史，不能复用活动行星的介质上下文。后处理借用输入，不拥有或提前释放 opaque depth。

## 时域与生命周期

- 几何运动至少由当前/上一帧模型与相机矩阵定义；云运动必须加入世界平流/自转，不能只投影静止球壳。射线抖动和前后帧 jitter 的约定由统一时域所有者管理。
- 反遮挡拒绝结合不透明深度、云占用/代表距离、透射和历史颜色范围；新显露、无云、视线离开介质不能读取有效云历史。局部 history 到统一 TAA 的迁移必须成套替换 jitter、拒绝和反馈，不留下两个独立累积器叠用。
- 切星/门户上下文变化、teleport、不连续时间跳变、介质参数或坐标编码改变、resize、质量档导致布局变化、context restore 必须失效。连续相机运动、天气平流和曝光变化应通过对应映射处理，而非无条件丢历史。曝光改变不能改变 T。
- 渲染目标由 pass 创建/resize/dispose；天气资源由 manager 按内容代际创建/取消/交换/释放；共享 LUT 按 profile 由大气 pass 管理。每个资源只有一个释放所有者，消费者仅借用；context restore 禁止跨 WebGL context 使用旧句柄。
- 预算沿用 B7；在接入新 GPU 表示时同时报告尺寸/格式/字节、常态和双场峰值。释放以实际最后消费者帧为准；当前两帧 grace 必须由实测支撑，不能视作所有后端/门户的普遍保证。

## 已实现的帧接口与边界（2026-10-20）

`GameLegacyPipeline.frameState` 是本视角的 `RenderFrameState`，不是第二个颜色累积器。主循环调用 `render({origin,context,timeEpoch})`：origin 是双精度导航原点，context 是实际系统对象，timeEpoch 是 `CelestialClock.epoch`（显式 set/advance 增加，连续 update 不增加）。begin 复制当前真实相机 world/projection/inverse-projection/view-projection、near/far、原点，以及活动行星的位置/旋转/天气来源；pending 期间 `current` 可读，`previous` 仅指最后一次成功提交。整帧与目标恢复成功后才交换快照；任一 pass 或恢复抛错则 abort，不把部分帧提交为 previous。不要在主循环重新赋值云的 historyValid。

云仍拥有原来的半浮点颜色/不透明深度双缓冲，但只在其 sequence 紧邻共同 previous 时复用；中间跳过 volume 的帧不会借用错帧矩阵。来源/行星、材质版本/表示、半径或深度编码改变均拒绝不匹配历史；resize、显式跳转、私有预热、context loss 失效。显式失效发生在私有预热恢复的第一步。连续 FOV、姿态和正常时钟变化使用前后矩阵，不因每帧变化一律清历史。

刚体对应为 `previousPoint = (previousRotation * inverse(currentRotation)) * currentPoint + delta`，delta 由两个原点相对各自行星中心的 CPU 双精度差构造；上传前不把宇宙绝对平移写进 float。积分与重投影均从真实镜头而非 nav 发射：空气、云、云照明支持和屏幕云影接收体使用真实局部眼点。地表材质眼点是每个材质自己的值，复用 `SurfaceViewFrame` 计算实际 draw camera 的局部位置，不改写共享天气 uniform；支持独立相机依次绑定。

这只修正当前刚体/视点对应。球壳代表位置仍是近似；没有新增云占用深度、天气平流补偿、逐物体 motion、云反遮挡/颜色限幅、曝光适配或完整 TAA。opaque/history depth 仍是对数不透明深度，不能解释为云深度。下一步在此接口上增加共同抖动/天气时间映射和几何运动消费者，成套替换局部反馈，禁止再叠一个独立累积器。[固定证据与边界](baselines/foundation-frame-state-2026-10-20/README.md)包含独立坐标参考、真实 resolve、介质偏移和正常玩家检查。

## 参考入口与升级规则

`tools/medium-reference.js` 给出常源均匀 slab 的解析解，`mediumreferencetest.js` 用独立细步进交叉验证。`b5transporttest.js` 通过真实不透明绘制、log depth、AtmospherePass、VolumePass 和实际半浮点 history 检查全部 8 例及细前景重建；`b0compositiontest.js` 现为该回归的兼容入口。给定常源传输与实际源项分开验证，后者见 `b5radiancetest.js`/`b5lightingtest.js`。

B5 已将已知缺口从“应能检出错误”升级为“与参考一致”。后续保留晴空、无空气云、单团、薄层、厚云、云内、前景遮挡和内部遮挡各例，不以删掉坏例使测试变绿。统一 TAA/资源接口若变更，更新本文版本及兼容说明，再迁移消费者。
