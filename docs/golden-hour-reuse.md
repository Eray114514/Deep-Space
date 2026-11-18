# Golden Hour（Solstice Hotel）复用目录

`GOLDEN HOUR — Solstice Hotel` 是用户的另一个程序化 Three.js 战术射击项目，位于 `D:\Eray0\下载\GOLDEN HOUR — Solstice Hotel`（用户已授权直接搬用与融合优化，2026-11-17）。

它与 [Saltline](saltline-reuse.md) 形成互补：
- **Saltline** 擅长**高细节手套双手建模、港口重工业道具、GPU 雨与涟漪、勘测机械狗/无人机**；
- **Golden Hour** 擅长**完整的多枪种模块化枪械库（含光学瞄具、倍镜、消音器、握把、激光与 10 套武器迷彩）、破片手雷、室内居住/指挥陈设家具、Voronoi 可碎裂三维玻璃窗、Verlet 刚体可击飞/爆炸物理道具、四足战术机械犬 K9、宇航/战术人形骨骼与第一人称低头可见下肢（fpbody）**。

**核心融合原则（用户决策）**：Golden Hour 原版的第一人称手臂网格（`hf`）观感不如 Saltline，因此**弃用 Golden Hour 的手部网格与暴力碰撞寻指求解器**，将 Golden Hour 的全部枪械机匣、活动机件、配件与迷彩**统一嫁接到 Saltline 的高细节手套双手（`buildHand`）与 9 弹簧关键帧控制器上**。

---

## 源码形态与提取工具

Golden Hour 同样是单文件压缩包 `dist/game.js`（2.8 MB，1,456 条顶层声明，Three.js r180 命名空间为 `Ct`）。[tools/saltline/extract.mjs](../tools/saltline/extract.mjs) 已升级支持 `--gh` 参数直接解析并还原 `THREE.*`：

```bash
node tools/saltline/extract.mjs --gh --modules
node tools/saltline/extract.mjs --gh --find "<文本>"
node tools/saltline/extract.mjs --gh <符号...> --stop Vn,a9,th --deps
node tools/saltline/extract.mjs --gh <符号...> --stop Vn,a9,th --out <文件>
```

说明：`Vn`、`a9`、`th` 分别是包内内联的 `mergeGeometries`、`mergeVertices`、`toCreasedNormals`，提取时使用 `--stop Vn,a9,th` 并改从 `three/addons/utils/BufferGeometryUtils.js` 导入。

---

## 已搬入与融合内容

| 内容 | Golden Hour 来源 | 本项目位置 | 说明 |
|---|---|---|---|
| **5 把主力/副武器 + 配件与迷彩系统** | `ak`（KR-7 步枪）、`vk`（Vesper 9 微冲）、`Ok`（M12 霰弹枪）、`GT`（Strix 9 手枪）、`Mp/gf/wp`（瞄具/枪口/下挂）、`P4`（10 套迷彩） | `src/golden-hour/weapons-engine.js`、`src/golden-hour/viewmodels.js`、共用套件 `src/saltline/viewmodel-kit.js` | 剥离原版 `hf` 手臂，全部改配 Saltline 手套双手、扳机指形变、雨滴水珠着色器与实时太阳/天光镜片反射（L-7）。与 PAC-9 组成 `surface-weapons.js` 的 1–6 号位完整武器库（数字键 `1–6` 或滚轮切换）：<br>1. `PAC-9 LONGSHORE`（Saltline 冲锋枪）<br>2. `KR-7 CARBINE`（全息瞄具 + 垂直握把 + 补偿器，往复枪机与防尘盖）<br>3. `KR-7 VANTAGE`（**2.5× 实景画中画光学倍镜**接入 `renderScopeView`，含物理出瞳暗角、蚀刻测距分划、消音器、激光指示器与林地迷彩）<br>4. `VESPER 9`（消音高射速微冲，前倾换弹与左侧拉机柄拍击 HK-slap）<br>5. `M12 BREACHER`（12 号泵动霰弹枪，单发 9 颗鹿弹，开火后左手联动护木泵动退红壳，**支持逐发塞入弹仓与开火随时打断换弹**）<br>6. `STRIX 9`（碳纤维迷彩战术手枪，0.48s 快速上膛拔枪，空仓挂机锁定套筒与空仓释放） |
| **破片手雷（Frag Grenade）** | `Z2`（`Nk`） | `src/golden-hour/weapons-engine.js`（`buildFragGrenade`），投掷物理位于 `src/saltline/surface-gameplay.js` | 5,948 三角面刻槽菠萝手雷。步行按 `Q` 拔销投出，沿星球曲率与当地重力弹跳（带弹跳声），引信到时触发火球、浓烟、冲击波环、弹坑贴花，并震碎周围玻璃、掀飞物理道具与杀伤敌方机器人；返回飞船自动补满 |
| **18 种 48 kHz 立体声合成武器与破坏音效** | `eZ`（`fo`） | `src/golden-hour/weapon-sfx.js`，接入 `src/saltline/sfx.js` 与 `src/audio.js` | 含步枪、亚音速消音、微冲、12 号霰弹轰鸣、护木前后泵动、霰弹塞入、手枪击发与套筒复进、手雷拔销/弹跳/起爆、岩石/金属着弹、跳弹、玻璃开裂/粉碎与命中提示音 |
| **室内居住与指挥家具库（44 种）与程序材质（52 套）** | `lD`（材质）与 `PD`（`gD/yD/wD/TD/_D/RD/CD`） | `src/golden-hour/furniture.js` | 办公桌、电脑、会议桌、办公椅、沙发、扶手椅、落地灯、台灯、吊灯、货架、冰箱、灶台、餐车、行李车、手提箱、床、躺椅、遮阳伞、绿植花箱、灭火器、垃圾桶、安全出口牌等共 44 种，用于地表据点与浮城指挥舱陈设 |
| **Voronoi 可碎裂三维玻璃窗与 Verlet 物理道具** | `Ew`（玻璃）与 `_w`（物理道具） | `src/golden-hour/destructibles.js` | 适配对数深度缓冲与局部切平面坐标系：子弹击中观察窗会生成裂纹并崩解为最多 3,200 片翻滚落地的三维玻璃碎片（碎洞允许后续子弹穿过）；物理道具（笔记本、垃圾桶、行李箱、警示牌）受弹道冲量翻滚弹跳，**灭火器受击或遇爆会诱发连锁爆炸** |
| **四足机械犬 K9、空间站人员骨骼与第一人称下肢（fpbody）** | `Ht0/Bt0/R7`（K9）、`oC/n7`（人形骨骼）、`X7`（fpbody） | `src/golden-hour/k9-and-body.js` | `GoldenHourK9`（2.48 万面、21 骨骼，含颈/头/颌/耳与四肢 IK 步态，支持 HALCYON 蓝白伴随型与敌对橙黑型）；`ColonistRig`（3.2 万面、34 骨骼，含探索者/工程师/安保三套配色，用于据点驻守与巡逻）；`FirstPersonBody`（剔除头颈肩臂避免遮挡视线，步行低头可见宇航服下肢、膝盖与靴子随地形法向迈步、下蹲与滑铲） |
| **战术下蹲、冲刺滑铲与步行战斗 HUD** | `Ow`（滑铲手感）与 `#cross`（命中与受击反馈） | `src/controls.js`、`src/saltline/combat-hud.js`、`src/saltline/surface-gameplay.js` | 步行按 `C`/`Ctrl` 平滑下蹲并收紧后坐力，冲刺中按 `C` 触发带侧倾动量的战术滑铲；步行 HUD 采用项目线稿规范（动态散布十字准星、霰弹环、白/金/红三级命中叉标、受击方向弧、探索服护盾自动充能条） |

---

## 陈列页与验证命令

- **3D 武器库交互陈列页**：`npm run dev` 后打开 `/tools/golden-hour/arsenal-gallery.html`（可切换全部 6 把武器、开镜、连发、战术/空仓换弹、调节雨湿与试听合成音效）。
- **85 种程序化道具陈列页**：打开 `/tools/saltline/prop-gallery.html`（一键切换 Saltline 41 种工业道具与 Golden Hour 44 种室内陈设）。
- **纯 Node 自动化测试**：
  - `node tools/goldenhourweaponstest.js`（121 项武器、配件、画中画瞄准镜、泵动霰弹与音频断言）
  - `node tools/goldenhourworldtest.js`（室内材质、44 种家具、Voronoi 碎玻璃、物理道具、K9、驻守人员与第一人称下肢断言）
- **实机 WebGL2 端到端测试与截图**：
  - `node tools/arsenalandoutposttest.js --gpu --out docs/reviews/saltline-golden-hour-2026-11-17`
