# Saltline 复用目录

Saltline 是用户用 Claude 网页端做的另一个项目，是一款港口射击游戏。它全部程序化生成，three.js r180。项目位于 `D:\Eray0\下载\Saltline`，用户已授权直接搬用（2026-11-15）。

本目录列出它有什么、我们搬了什么、剩下的去哪里找。**要做人类工程、敌人、道具、音频或材质时，先查这里，不要从零开发。**

## 源码形态与提取工具

Saltline 没有可读源码，只有一个压缩过的 esbuild 单文件包 `public/engine/saltline.js`（1.4 MB）。claude.ai 上的 artifact 也只存了同一份压缩 HTML。

提取工具是 `tools/saltline/extract.mjs`，原理如下：
- 用 acorn 解析整个包，对每个顶层语句做作用域分析；
- 给定一个符号，取出它和它依赖的全部顶层声明；
- 把 three.js 的别名（包内 `lt` 命名空间）还原成 `THREE.Xxx`；
- 用 esbuild 重新排版输出。

```bash
node tools/saltline/extract.mjs --modules              # 列出模块（esbuild 命名空间）
node tools/saltline/extract.mjs --find "<文本>"        # 找含某段文本的顶层语句
node tools/saltline/extract.mjs <符号> --deps          # 看依赖闭包
node tools/saltline/extract.mjs <符号> --stop sa --rename tools/saltline/maps/<名>.json --out <文件>
```

使用注意：
- `--rename` 用 JSON 把顶层符号改成可读名，示例见 `tools/saltline/maps/pac9.json`。函数内部的局部变量名仍是生成名。几何构建函数内部的这些名字当数据看待；控制逻辑才需要手工改写。
- `sa` 是包里内联的 `mergeGeometries`。用 `--stop sa` 跳过它，改从 `three/addons/utils/BufferGeometryUtils.js` 导入。
- 闭包只跟随声明，不包含顶层的副作用语句，比如材质烘焙着色器的注册 `Tn.asphalt = …` 和道具注册 `J3(_i)`。提取时用 `--effects Tn` 这样的参数，把引用该变量的副作用语句和它们的依赖一起带出来。
- 第 332 号语句（`oi, Mn, en, Pi, Pr…`）是 Saltline 的场景常量：太阳方向、天空色、玩家尺寸和画质档。提取物引用这些常量时，改成本项目的值或模块常量（例子见 `pac9-viewmodel.js` 的 `LENS_SUN` / `LENS_SKY`）。
- 汉化是直接打在压缩包上的，以后如果拿到 Saltline 的新版本，要重新汉化。

### 查看原版效果

`file://` 打开的页面不能截图，要用 HTTP 服务托管 `dist/`。参数：
- `?autostart=1`：直接进入一局。
- `?show=<模块>`：单独展示某个模块，可选 `mats | level | backdrop | ground | fx | weapon | enemies | props | render`。
- `&eshow=hound|gull`：只展示某个敌人。
- `window.__G`：运行时对象。

## 已搬入

| 内容 | Saltline 来源 | 本项目位置 | 说明 |
|---|---|---|---|
| PAC-9 Longshore 第一人称武器 | `Xv` 模块，`dm` 及其 49 条依赖 | `src/saltline/pac9-viewmodel.js` | 枪体几何、戴手套的双手、扳机指形变、红点镜（含镀膜反光）、枪口焰着色器、微细节/雨湿着色器，原样保留。控制器按原数学改写为上下文接口，包括战术和空仓两套关键帧换弹、弹匣随左手移动、9 组弹簧后坐与摆动、开镜、冲刺、跳跃落地、闲置检视。是 `surface-weapons.js` 的 1 号位（替换 KX-9）。另外加了 Saltline 没有的三个动作：下船落地自动掏枪（枪从收起姿态抬起，左手拉一下拉机柄上膛，约 1 秒）；登船或按 `G` 收枪（约 0.4 秒压低移出画面，`G` 或左键再掏出来）；放松持枪（3.5 秒没有开火、瞄准、换弹就垂到低位戒备，一按射击或瞄准约 0.05 秒抬起）。暂停不会触发收枪 |
| 武器层独立相机 | Saltline 的 `viewCamera`（fov 54） | `surface-weapons.js` 的 `viewCamera` 与 `foreground-pass.js` 的 `setLayerCamera` | 近裁面 0.01，不再切掉手和瞄具。其余三把枪跟随世界 fov，外观不变 |
| GPU 雨与地面溅水 | `Nb` 及着色器 `kR/FR/UR/NR` | `src/saltline/rain.js`，由 `weather-effects.js` 调用 | 12k 个实例化面片；雨场固定在世界中（不跟着玩家走）；按像素宽度控制线宽；太阳前向散射光照；溅水按 7×7 地形高度网格贴地。改成了球面切平面坐标系，并加了对数深度。`?rain=0..1` 可强制下雨，`?rainGain=` 调亮度 |
| 武器雨湿 | `Wv`（`uRain`） | `SurfaceWeapons.setWetness` | 下雨时枪面出现水珠、颜色变深、粗糙度降低，雨停后数秒内变干 |
| 合成音效库（全部 57 种，包括枪声、换弹、弹壳、命中、脚步、雨、风、雷、无人机旋翼、机器狗伺服、混响冲激响应、配乐片段） | 渲染入口 `r_` 与生成器表 `Go`（第 765 号） | `src/saltline/sfx-generators.js`（生成代码），播放器为 `src/saltline/sfx.js` | 第二轮（2026-11-16）接入：PAC-9 的开枪（含户外回声尾音）、弹壳落地、拔弹匣、插弹匣、拉枪栓、空仓击发；步行时的雨声和闪电后的雷声。播放器在空闲时预渲染，各音效有变体轮换和并发上限。还没接入的音效（命中、脚步、无人机和机器狗、风、海、配乐）也都在库里，按名称调用 `audio.sfx.play(名称)` 即可；`node tools/saltline/render-sfx.mjs --list` 列出全部名称，加 `<名称> --out x.wav` 可导出试听 |
| 材质库：27 套程序纹理（混凝土、油漆、镀锌/拉丝/锈蚀钢、枪械阳极、聚合物、布料、木、轮胎、玻璃等）和 48 种命名材质 | 材质模块 `qg`（`Gg`）；每套纹理的烘焙着色器由副作用语句 `Tn.<名称> = …` 注册 | `src/saltline/materials.js` | 第三轮（2026-11-16）接入：首次用到某套纹理时，由 GPU 一次烘焙出反照率、ORM（AO/粗糙度/金属度）和法线三张图，不需要图片文件。共用的着色器补丁负责三平面投影、宏观色斑、积灰和雨湿（`mats.uniforms.wet`）。PAC-9 的手套和黄铜已改用 `glove_fabric` / `brass`。全部材质的陈列页：`npm run dev` 后打开 `/tools/saltline/material-gallery.html`（加 `?wet=1` 看湿润效果）。这些材质全是人造物，没有草、土、岩、沙、雪；地表重做只复用它的烘焙框架和雨湿补丁。冷启动时烘焙两套纹理约 430 ms，命中着色器缓存后约 20 ms；29 套全部烘焙的冷启动约 18 s，所以只能按需烘焙 |
| 机器狗"猎犬"与无人机"海鸥"（HALCYON 勘测单位） | 敌人模块 `ex`（`Em`）：骨骼与网格 `Z_`（猎犬）/ `j_`（海鸥）、行为体 `iM`（猎犬，含步态）/ `Q_`（海鸥，含悬停、云台、探照灯） | `src/saltline/robots-engine.js`（生成代码），适配层 `src/saltline/robots.js` | 第五轮（2026-11-16）接入：飞船停在星球上、玩家在船外或船内时，一只机器狗和一架无人机在着陆点周围巡逻（被动模式，不感知、不交战），起飞时收回。适配层在停靠点建立局部切平面坐标系：地面高度来自 `planet.height`（全频率，带缓存），射线是对地面的步进求交，能否通行看坡度、海平面和飞船周围 12 m 的禁区；还负责把相机换算成"玩家"、提供带声像的旋翼/伺服循环声，以及共享武器的户外天空反射环境（Saltline 材质金属成分高，用太空环境会发黑）。启动后空闲时预热：用并行着色器编译烘焙 `armor` / `gunmetal` 纹理、建好网格、预编译渲染程序，主线程最长任务约 60 ms，落地时只需激活。几何：猎犬 17.3k 三角面，海鸥 13.4k |

验收工具：`tools/pac9viewmodeltest.js`、`tools/rainvisualtest.js`（加 `--gpu --out <目录>` 可截图）。

## 待搬清单（按建议顺序）

| 内容 | 来源符号 | 闭包规模 | 搬法与注意事项 |
|---|---|---|---|
| **敌人 AI**（用户要求记录） | 机器狗行为体 `iM`、无人机行为体 `Q_`，调参 `ROBOT_TUNE`（原 `Ui`：视野 45 m、视锥 200°、丢失目标 4 s、搜索 8 s、听觉半径 45 m、同时进攻配额 2/3 个、间隔 1.25 s、暴露度升降）；射击接口 `playerShot` 在 `zv`（尚未搬） | 已随机器人搬入 `src/saltline/robots-engine.js`，目前没有启用 | 有战斗玩法时，只要 spawn 时不传 `passive: true`，再给适配层补上真实的 `player.damage`、`combat`（`enemyShot`、`explode`）、`fx`（火花、烟、碎片、曳光）和 `events`（`weapon:fire` 会惊动 `hearRadius` 内的敌人）。机制：视锥 + 听觉警戒；巡逻、调查、交战、搜索状态机；用"进攻令牌"限制同时开火的敌人数量；对象池 |
| 道具库（约 30 种）：集装箱、叉车、发电机、灯塔杆、沙袋、木材堆、吨桶、工具车、楼梯、岗亭等 | `$g`：`PROP_SIZES = Gi`，注册函数 `J3` / `eb` / `sb` | 分别 55、37、43 条（37、25、38 KB） | 依赖材质库。用于 `artificial-sites.js` 的地表据点；配色可改为科幻风 |
| 特效：曳光、抛壳、硝烟、弹孔贴花、命中碎屑 | 特效模块 `Sv`（`Cf`） | 20 条，约 50 KB | 和战斗一起搬；弹孔贴花依赖命中射线 |
| 地面雨湿与雨点涟漪 | 地面模块 `vv`（`O1`）；涟漪着色器在第 637 号语句（`TR / AR / RR`，"one sparse layer of rain rings"） | 25 条，约 39 KB | 是雨的下一步：地表变暗、变亮滑，积水出现涟漪。随[地表重做](planet-surface-rewrite.md) T3 接到新地形材质上，不能改动地形高度流 |
| 后处理参考：AgX、自动曝光、色差、暗角、颗粒、锐化 | 渲染模块 `Vg`（`Hg`）、`jy`（第 365 号） | 16 条，约 54 KB | 只参考参数，不替换我们的管线（WebGL2 基准不变） |
| 关卡、远景、天空 | `cv`（`C1`）、`mv`（`pv`）、`SALTLINE_SKY` | 51 KB / 57 KB | 单场景天空罩，不搬，我们的大气和云更强。远景的起重机、船等模型可以拆出来单独用 |

## 已知余项（本轮未做）

- 红点镜反光使用的太阳和天空颜色是 Saltline 港口的常量（`LENS_SUN` / `LENS_SKY`），还没接本项目的实时太阳方向和天空色。
- 地表射击没有命中模型，曳光弹仍飞向准星下的地形距离。
- 2026-11-16 起只保留 PAC-9：低模的 CX-5、M77、HLX-3（采矿激光本来也没有玩法）连同 `weapon-models.js` 和 `hlx-3-prospector.glb` 已删除。新武器至少要达到 PAC-9 的标准：带手、关键帧动作、合成音效。瞄准镜的离屏渲染约定（`renderScopeView`）保留了下来，供将来的带镜型号使用。
- 合成音效的音量是按电平估的，还没有人实际听过；可以用 `docs/reviews/saltline-port-2026-11-16/pac9-audio-demo.wav` 试听。
- 雨在强制晴天下偏淡。真实降雨天气下天空更暗，雨会更明显。地面湿润效果待搬（见上表）。
