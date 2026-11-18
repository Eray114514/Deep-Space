# Saltline 复用目录

Saltline 是用户用 Claude 网页端做的另一个项目，是一款港口射击游戏。它全部程序化生成，three.js r180。项目位于 `D:\Eray0\下载\Saltline`，用户已授权直接搬用（2026-11-15）。另一座互补项目的迁移清单见 [Golden Hour 复用目录](golden-hour-reuse.md)。

**截至 2026-11-17，Saltline 中可搬用的全部核心内容（第一人称武器与双手、独立相机、GPU 雨与溅水、武器与地面雨湿涟漪、57 种合成音效、48 种 GPU 烘焙材质、机器狗与无人机及其完整战斗 AI、41 种工业与港口道具、战斗与表面命中特效）均已完成迁移与接入。**

## 源码形态与提取工具

Saltline 只有一个压缩过的 esbuild 单文件包 `public/engine/saltline.js`（1.4 MB）。提取工具 [tools/saltline/extract.mjs](../tools/saltline/extract.mjs) 同时支持 Saltline（默认）与 Golden Hour（`--gh`）：

```bash
node tools/saltline/extract.mjs --modules              # 列出模块（esbuild 命名空间）
node tools/saltline/extract.mjs --gh --modules         # 列出 Golden Hour 模块
node tools/saltline/extract.mjs --find "<文本>"        # 找含某段文本的顶层语句
node tools/saltline/extract.mjs <符号> --deps          # 看依赖闭包
node tools/saltline/extract.mjs <符号> --stop sa --rename tools/saltline/maps/<名>.json --out <文件>
```

## 已搬入清单（全量完成）

| 内容 | Saltline 来源 | 本项目位置 | 说明 |
|---|---|---|---|
| PAC-9 Longshore 第一人称武器与共享双手套件 | `Xv` 模块，`dm` 及其 49 条依赖 | `src/saltline/pac9-viewmodel.js`、`src/saltline/viewmodel-kit.js` | 枪体几何、戴手套的双手（`buildHand`）、扳机指形变、红点镜镀膜反光、枪口焰着色器、微细节/雨湿着色器完整保留；新增下船拔枪上膛、登船或按 `G` 收枪、3.5s 放松低姿戒备。**`buildHand` 与光学镜片着色器已抽出为 `viewmodel-kit.js`，同时驱动 Golden Hour 迁入的全部 5 把新武器** |
| 红点镜与光学瞄具实时天光反射（L-7） | `LENS_SUN` / `LENS_SKY` | `src/saltline/viewmodel-kit.js`（`setLensEnvironment`）、`src/surface-weapons.js` | 红点镜、全息镜与微红点的镀膜反射已改为实时跟随当前星球的太阳方向、恒星色温与大气天顶/地平线颜色 |
| 武器层独立相机与实景倍镜管线 | `viewCamera`（fov 54） | `src/surface-weapons.js`、`src/foreground-pass.js` | 近裁面 0.01 不切手与瞄具；`renderScopeView` 已接入 3 号位 `KR-7 VANTAGE` 的 2.5× 实景画中画光学瞄准镜 |
| GPU 雨与地面溅水 + 武器雨湿 | `Nb`、`kR/FR/UR/NR`、`Wv`（`uRain`） | `src/saltline/rain.js`、`src/weather-effects.js` | 12k 实例化雨线 + 7×7 地形高度溅水，对数深度适配；下雨时全部 6 把武器与手套出现水珠并变深变亮 |
| 地面雨湿与水洼雨滴涟漪（L-3） | 地面模块 `vv`（`O1`），第 637 号语句 `TR/AR/RR` | `src/saltline/wet-ground.js`，已接入 `src/artificial-sites.js` 与前沿营地 | 纯解析哈希（零 RNG 污染），支持旋转/轴倾球面星球切平面法向：地面湿润变暗、平坦低洼积水高光、三层旋转叠加的雨滴同心圆涟漪法线扰动；同时保留独立补丁接口供 T3 新地形材质合流直接调用 |
| 合成音效库（57 种）+ 环境与脚步声全量接入（D-03） | 渲染入口 `r_` 与生成器表 `Go` | `src/saltline/sfx-generators.js`、`src/saltline/sfx.js`、`src/audio.js`、`src/saltline/surface-gameplay.js` | 与 Golden Hour 的 18 种武器/手雷/碎玻璃音效合并（共 75 种）。已接入全部 6 把武器的开火/换弹/泵动/拉栓/抛壳、步行脚步（区分浅水、金属甲板、混凝土地坪与自然土石）、跳跃/落地/滑铲、狂风循环（`wind`）、海岸浪声循环（`sea`）、降雨与雷声、着弹与跳弹、机器人旋翼/伺服与交战音效 |
| 材质库（27 套程序纹理、48 种命名材质） | 材质模块 `qg`（`Gg`），注册表 `Tn.*` | `src/saltline/materials.js` | 按需 GPU 烘焙反照率/ORM/法线三张贴图（软件 WebGL 自适应降为 256px 保护测试启动速度，硬件 GPU 为 1024px）。陈列页：`/tools/saltline/material-gallery.html` |
| 工业道具库（36 种）+ 港口远景巨构（5 种）（L-5） | `$g`（`Gi/Yg/J3/eb/sb`）及远景 `mv`（`Eb`） | `src/saltline/props-engine.js`、`src/saltline/props.js`，已铺设至 `src/artificial-sites.js` 与前沿营地 | 共 **41 种**：集装箱（20/40/40HC）、叉车、发电机、灯塔杆、岗亭、道闸、沙袋、IBC 吨桶、气瓶架、电缆盘、货架、金属楼梯、猫道、中继节点等 36 种道具，外加 `port_crane`（51m 岸桥起重机）、`rtg_crane`（30m 龙门吊）、`cargo_ship`（63.5m 货轮）、`rigid_boat`（快艇）、`comms_tower`（36.4m 桁架雷达塔）。支持 `industrial` / `frontier` / `halcyon` 三套配色。陈列页：`/tools/saltline/prop-gallery.html` |
| 战斗与表面命中特效 + 地表命中模型 | 特效模块 `Sv`（`Cf`）与射击结算 `zv` | `src/saltline/fx.js`、`src/saltline/surface-gameplay.js` | 对数深度适配与浮动原点平移（`shiftOrigin`）。补齐地表全链路射线命中模型：支持命中敌方机器人（弱点 2.2×）、可碎玻璃、物理道具、静态掩体、星球海面与地形高度场，生成对应材质火花、碎屑、扬尘、水花、硝烟、爆炸火球与弹孔/灼烧贴花 |
| 机器狗"猎犬"与无人机"海鸥"：勘测巡逻 + 据点巡逻与完整战斗 AI（L-4） | 敌人模块 `ex`（`Em/iM/Q_/Ui`） | `src/saltline/robots-engine.js`、`src/saltline/robots.js`、`src/saltline/surface-gameplay.js` | 双实例架构：飞船停靠时部署 1 狗 1 无人机友好勘测（`passive: true`）；靠近星球人类据点或触发遭遇战（`NMS.spawnCombatEncounter()`）时部署据点防卫编队，完整启用视锥感知、45m 开火听觉惊动、巡逻/调查/交战/搜索状态机、进攻令牌配额、弱点伤害、等离子弹道与坠毁残骸 |

## 验证与陈列工具

- `node tools/saltlinepropstest.js`：41 种道具三配色构建、FX 九种表面命中与浮动原点、雨湿着色器纯 Node 回归（30/30）。
- `node tools/pac9viewmodeltest.js [--gpu]`：PAC-9 拔枪、开镜、连射、战术/空仓换弹、收枪与低姿戒备。
- `node tools/surveyunitstest.js [--gpu]`：飞船勘测机器狗与无人机巡逻、避让、环境反射与起飞回收。
- `node tools/rainvisualtest.js [--gpu]`：GPU 雨线与地面溅水。
- `node tools/arsenalandoutposttest.js [--gpu]`：6 把武器切换与开火、2.5× 实景瞄准镜、前沿据点、碎玻璃、手雷爆炸、第一人称下肢与机器人交战全链路端到端验证。
