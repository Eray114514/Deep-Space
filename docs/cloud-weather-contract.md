# B4 首族与天气接线契约

更新：2026-09-26。对应[难度表](remaining-work-difficulty.md)的 **B4-01**；完成状态只写入[父计划](cloud-atmosphere-rewrite.md)。本页约定接线语义，不冻结纹理布局或要求迁移整套 CPU 烘焙管线。

## 第一族：层积云

首个生产闭环采用 `stratocumulus`：浅层、胞状、有晴空孔隙，适合同时检查宏观云区、内部空隙、局地高度、近远一致性和云影。它比深对流和薄纤维云少一组采样难题，仍能暴露当前灰膜/平顶问题。不是把所有低云永久改成层积云。

`cloud-species.js` 的 2000 m 名义厚度、2200 m 水平特征和 30/km 消光只是已有 CPU 参数起点，未获生产画面验收。它们不按行星半径缩放，也不能直接替换旧壳厚后宣告完成。首族通路先保留已有微观雕刻，逐项比较胞状结构和光学结果；B4-08～10 解决采样、自阴影和云内散射。

## 已落地的查询边界

`src/cloud/cloud-environment.js` 提供两个无 Three/GPU 依赖的查询：

- `sampleCloudColumn(planet, localDirection)`：规范化体固方向，读取真实 `Planet.height(direction, fullMaxFreq)` 与平均液面。
- `sampleCloudEnvironment(planet, bodyLocalMeters, absoluteHours)`：在上述柱信息上添加径向高度、离地/离液面净空、绝对时刻。

它们**尚未接管天气、密度或绘制**，目前由契约测试消费，供 B4-02/03 接线复用。没有新增每帧工作、GPU 资源或第二套天气状态。`CLOUD_ENVIRONMENT_VERSION` 只表示查询结构版本，不是天气内容版本。

| 字段/输入 | 唯一含义 |
|---|---|
| `bodyLocalMeters` | 以行星中心为原点、随行星自转的坐标，单位米；+Y 为本地极轴 |
| `direction` | 同一体固坐标中的单位方向，不含相机、天气风偏移 |
| `altitudeMeters` | `length(bodyLocalMeters) - R`，相对基准球面，可为负 |
| `terrainAltitudeMeters` | 真实地形相对 R 的高度，固定使用 canonical `fullMaxFreq`，不取当前可见网格 LOD |
| `seaAltitudeMeters` | 平均液面相对 R 的高度；无液体时为 `null`，不泄露旧 `-1e9` 哨兵 |
| `surfaceAltitudeMeters` | 有液体时取地形与平均液面的较高者，否则取地形；不含瞬时波峰 |
| `terrainClearanceMeters` / `surfaceClearanceMeters` | 径向高度减相应表面高度；保留负值，不把山体内部伪装成地面上 |
| `surfaceIsLiquid` | 此柱平均液面高于地形；是局地点分类，不等于天气模型需要的区域海洋比例 |
| `absoluteHours` / `absoluteSeconds` | 同一 `CelestialClock.hours` 及其 ×3600 换算；允许回溯，不取模、不积累帧 dt |

非有限坐标/时刻、零向量、无有效地形源会报错。不得悄悄回退为北极、零时刻或一颗默认行星。

坐标接入规则：宇宙坐标先用 `Planet.worldPositionToLocal`；相对行星的世界轴偏移用 `worldOffsetToLocal`。渲染浮动原点坐标先减去**同一原点**下的行星中心，再旋回体固坐标。CPU 在 JS double 中完成大坐标相减，GLSL 使用局部坐标/锚点；不要先把宇宙大数转成 float32 再相减。门户必须用目标行星的变换与时刻。

## 接下来统一的内容输入与输出

以下是迁移契约，**尚不是已完成的生产 API**。B4-02 在唯一天气所有者中实现，不能让每个消费者自行解释。

| 项目 | 约定与待实现边界 |
|---|---|
| 身份 | 内容身份包含 `galaxyId / systemId / bodyId`、seed 和生成参数；只用局部 `bodyId` 或对象引用作跨系统缓存键不够 |
| 内容版本 | 天气/云种/密度算法版本、地形/海平面/气候参数修订组成内容 revision；同 revision 同坐标同时间应可重建。查询结构版本、资源 generation 和内容 revision 分开 |
| 时间 | 所有消费者接同一绝对小时。`weatherSpeed` 只影响演化速率，不再把输入时钟乘一次。冻结、回溯、重载和跳时都显式传时间 |
| 帧一致性 | 一次绘制的云、远云、阴影、反射和局部玩法读同一内容 revision 与采样时刻；异步结果整代交换。不能一个更新了天气、另一个还拿旧纹理 |
| 地形与气候 | 使用真实柱数据；区域海洋比例/地形导数可平滑，但平滑尺度是内容参数，不能随画质变化。不得把合成地形代理当真实山脉 |
| 覆盖 | 大尺度 mask 定义云区和晴空，微观形态保留云区内孔隙；CPU `obstruction` 只是代理。最终 C5 另测积分透射和等面积遮挡 |
| 局地云底/云顶 | 最终 band 都用相对 R 的米制高度。LCL 表示起始空气上升到凝结所需的高度，必须明确起始空气面的高度后再转换；不能当成已是径向高度 |
| 高山/雾/高云 | 局地边界层的起始面与平滑尺度在 B4-03 定案，禁止直接用整球最高山抬云，亦禁止每个山尖都强制顶起整片云。雾随局地表面，高云用独立大气高度条件 |
| 密度/光学 | 分开记录无量纲凝结密度与 `extinctionPerMeter`；表内 `/km` 在边界除以 1000。云段 `tau = ∫ sigma_t ds`，步长单位米；不再由观察者或壳厚重定义消光 |
| 风 | 明确体固切向单位方向与 m/s 速率，或明确 m/s 速度向量。CPU 候选 `windVector.xyz` 是方向，另有 `.speed`；不能直接当米/秒速度。云平流位移与 B7 运动信息共用定义 |
| 太阳/照明 | 生产双星照明继续消费 B5 的实际恒星场。CPU 候选用固定 +Y 旋转推太阳的热力学近似，接线时须明确校正范围，不能当真实轨道/双星照明 |
| 质量档 | 只选采样、过滤、步数和重建；不改内容 revision、天气布局、云底/云顶或消光。首族就做同点/同柱对照 |

不在这里增加独立 history。继续保留 B5 的 `C + Tc * Bair`；全屏 TAA、云占用深度与风运动补偿属于 B7。

## 消费者迁移位置

| 消费者 | 当前实际入口 | B4 迁移要求 |
|---|---|---|
| 主体积云 | `planet.js` 的 `makeCloudTextures` → `clouds-webgl.js`；旧低/高 atlas | 换成唯一天气内容派生的密度，保护 B5 传输和微观细节 |
| 太空解析云 | `planet.js` 的 `cloudMesh/cloudMesh2` 与 `shaders.js` 云材质 | 从同一场派生远景，保持云区、柱光学厚度和风相位 |
| 地表/水面云影 | `cloudShadowTex` 及 `shaders.js` 的云影 uniform | 不把单层 atlas 的“黑白程度”继续当所有云族的独立覆盖权威 |
| 水面反射 | `setWaterEnvironment`、水面 shader 的天空/云输入 | B4-05 做首族样例，B6-03 再完成方向性天空与反射/折射合流 |
| 局部降水/能见度 | `Planet.weatherAt` → `main.js` 的 `activeWeather`、`weather-effects.js`、步行天气 | 由同一天气派生，保留场景夹具能力；迁移时不能让云晴空而地面下雨 |
| 海况与植被风 | `oceanAt/sampleWaterSurface`、`setWeatherWind` | 统一时刻、风方向/速度单位；不得随相机切换天气内容 |
| 云内玩法状态 | `Planet.cloudTransit` | 当前近似需对齐实际密度；不能回退为覆盖率驱动的整屏雾 |
| 旧 CPU 烘焙/worker | `cloudResourceDescriptor/ensureCloudResources` → `src/cloud/*` | 当前 `phase4-A` 门控不是生产接线证据；若选纹理方案，补真实地形序列化、时间更新、上传/释放验证 |

B4-02 先建立唯一所有者和迁移适配器，B4-03/04 接局地 band 与首族真实密度，B4-05 完成首族跨消费者链。中间提交可以保留旧生产路径作对照，但必须显式标记，不能把两套独立覆盖混用称作 C1 通过。

## 固定测试点与验收边界

`tools/b4-weather-fixtures.js` 固定出生系的 0/2/4 号行星，12 个体固方向（赤道四向、两极、经度缝两侧、四个中纬点），时刻 0/9.5/48.5 h，径向高度 800/12000/300000 m，共 324 个查询。报告记录实际 body ID、seed、半径、地形与液面，防止把索引当稳定世界身份。

这些点是坐标/地形控制组，不承诺恰好位于层积云或每个天气系统。B4-02 接新场时，另固定晴空区、云区、锋面、眼/眼墙、副高、海陆交界的坐标，保留本组控制；不能每轮搜索最容易通过的点替换失败点。B4-04 再追加实际 GLSL 密度 readback 与首族玩家机位。

运行 `npm run test:b4:contract`：纯 Node 校验海底/液面/山体净空、绝对时钟、独立海平面变化和非法输入；浏览器用真实 Planet 的坐标变换/地形做 324 例，检查两种浮动原点与多次时间跳转后的可重现性。它不验证新天气已上线、GPU 密度/光学一致性或最终云形。

本阶段证据见 [B4-01 报告](baselines/b4-01-2026-09-26/report.json)。B5 历史图保持原归档；本阶段没有改变云场或渲染，不为接口工作生成一套重复画面。真正改变场的下一阶段按 B5 协议重采。
