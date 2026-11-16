# Saltline 移植第一轮（2026-11-16）

目录与待办见 [Saltline 复用目录](../../saltline-reuse.md)。

## 交付

- **PAC-9 Longshore 替换 KX-9**（1 号位），代码在 `src/saltline/pac9-viewmodel.js`：戴手套的双手（扳机指会形变）；战术换弹和空仓换弹两套关键帧，弹匣跟着左手离开机匣；9 组弹簧后坐与摆动；开镜 / 冲刺 / 跳跃落地 / 闲置检视；红点镜；枪口焰。
- **武器层独立相机**（近裁面 0.01，fov 54）：手和瞄具不再被世界相机 0.12 m 的近裁面切掉。
- **GPU 雨**（`src/saltline/rain.js`）替换原来 1450 根 CPU 线段：雨场固定在世界中，按像素宽度控制线宽，太阳前向散射光照，地面溅水，并接入对数深度。
- **武器雨湿**：下雨时枪面出现水珠、颜色变深、变亮滑。

## 截图（`--gpu`，1280×720）

| 文件 | 内容 |
|---|---|
| `pac9-hip.png` / `pac9-ads.png` / `pac9-reload.png` | 腰射、开镜（红点）、换弹（左手握出弹匣） |
| `saltline-original-reload.png` | Saltline 原版换弹，对照用 |
| `rain-day.png` / `rain-dusk.png` | 用 `?rain=0.85` 在晴天强制下雨的白天与黄昏画面（真实降雨天气下天空更暗，雨会更明显） |

## 验证

- `npm test`：只有 `worldlocktest` 失败。这是重构期间已有的宇宙锁漂移，按 AGENTS.md 暂不处理；其余全部通过。
- `npm run test:smoke` 通过。
- `node tools/pac9viewmodeltest.js --gpu`：10/10 通过。
- `node tools/rainvisualtest.js --gpu`：5/5 通过。
- `npm run test:gameplay`：武器相关检查通过。起飞那一步在 SwiftShader 下需要约 49 s，在未修改的 HEAD 上测得同样耗时，属于已有问题，原 30 s 等待已放宽到 90 s。

## 本轮修过的坑

- 渲染器开启了 `logarithmicDepthBuffer`，自写的 `ShaderMaterial` 必须带 three 的 logdepth 片段，否则会和地形深度对不上，雨只能显示在天空前面。
- 低频 `planet.height(dir, 64)` 和步行实际使用的 `fullMaxFreq` 地面相差约 100 m，贴地计算要用 `fullMaxFreq`。
- 提取工具的改名最初漏掉了"在同一条声明语句内引用自己的顶层名"，已修。

## 第二轮（同日）

- **删除低模武器**：去掉 CX-5、M77、HLX-3（采矿激光本来也没有玩法），连同 `weapon-models.js` 和 `hlx-3-prospector.glb`。`SurfaceWeapons` 重写为只管理 viewmodel，原来的方块枪、激光、旧换弹、旧枪口焰代码随之删除；瞄准镜离屏渲染的约定保留，并改为按模型判断是否带镜。
- **合成音效**：搬入 Saltline 的整套合成音效库（`src/saltline/sfx-generators.js`，57 种），由播放器 `src/saltline/sfx.js` 接到 `audio.js`。PAC-9 的开枪（含户外回声尾音）、弹壳落地、拔弹匣、插弹匣、拉枪栓、空仓击发都是合成音；步行遇雨有雨声，闪电后有延迟的雷声。
- 试听文件：`pac9-audio-demo.wav`（8 连发 + 战术换弹 + 空仓），可以用 `node tools/saltline/render-sfx.mjs --demo` 重新生成。

验证：
- `tools/pac9viewmodeltest.js --gpu`：16/16 通过，新增 6 项音效播放计数。
- `test:smoke` 通过；`renderframepacinggputest` 通过（瞄准镜辅助渲染约定）。
- `npm test` 仍然只有宇宙锁失败。

## 第三轮（同日）：材质库

- 搬入 Saltline 材质库（`src/saltline/materials.js`）：27 套 GPU 程序纹理、48 种命名材质，共用的着色器补丁负责三平面投影、宏观色斑、积灰和雨湿。没有图片文件。
- PAC-9 的手套（`glove_fabric`）和黄铜（`brass`）改用正式材质，雨湿通过 `mats.uniforms.wet` 和武器同步。
- 提取工具新增 `--effects`：每套纹理的烘焙着色器是用 `Tn.<名称> = …` 这样的副作用语句注册的，不属于声明，原来的依赖闭包带不出来。
- 陈列页 `tools/saltline/material-gallery.html`。截图 `materials-dry.png` / `materials-wet.png`，换弹时手套近景见 `pac9-gloves-material.png`。

开销：游戏冷启动时烘焙两套纹理约 428 ms（整个冷启动约 30 s），热启动约 18 ms，显存约 5 MB。全部 29 套冷启动烘焙要约 18 s，热启动约 0.2 s，所以只按需烘焙。

验证：`pac9viewmodeltest --gpu` 16/16 通过；`test:smoke` 通过；`npm test` 仍然只有宇宙锁失败。

## 第四轮（同日）：掏枪、收枪、放松持枪

Saltline 一直持枪，没有这些动作；这里用 PAC-9 现有的关键帧和弹簧补出来。
- **掏枪**：进入步行时自动触发。枪从收起姿态抬起，左手搭在拉机柄上，在 0.57 s 拉到底、0.62 s 放开（伴随上膛声和弹簧抖动），1.05 s 回到护木。
- **收枪**：离开步行（登船、起飞）或按 `G` 时触发，0.42 s 内压低并转向右下方移出画面，动画播完才隐藏武器层。`G` 或左键可以再掏出来。暂停单独传入，不算离开步行。
- **放松持枪**：3.5 s 没有开火、瞄准、换弹后，枪垂到低位戒备；按射击或瞄准时约 0.05 s 抬起，然后开火。
- 截图：`pac9-draw.png`（掏枪，左手在拉机柄上）、`pac9-lowered.png`（低位戒备）。

验证：`pac9viewmodeltest --gpu` 22/22 通过，新增落地掏枪、`G` 收枪/掏枪、放松持枪、放松状态下开火 4 项检查。

## 第五轮（同日）：机器狗与无人机

- 搬入 Saltline 的机器人模块（`src/saltline/robots-engine.js`，行为体和 AI 原样保留），作为 **HALCYON 勘测单位** 上线：飞船停在星球上时，一只机器狗、一架无人机在着陆点周围巡逻，起飞时收回。用的是被动模式，只巡逻，不感知玩家、不交战。
- 适配层 `src/saltline/robots.js`：局部切平面坐标系、基于地形的"物理"（地面高度、射线、通行判断、飞船禁区）、带声像的旋翼/伺服循环声（`SaltlineSfx.voice`）、共享武器户外天空反射（`WeaponLighting.environmentTexture` / `reflectionScale`）。
- 开销：首次落地现场建造时，冷启动要 2 s、热启动要 0.7 s，几乎都花在两套纹理的烘焙着色器编译上。改为启动后空闲时预热（材质库新增 `prepareAsync`，用 `compileAsync` 并行编译），预热期间主线程最长任务约 60 ms（基准 50 ms），落地时只需激活。
- 截图：`survey-hound.png`（机器狗近景）、`survey-gull.png`（无人机和探照灯）。

验证：`tools/surveyunitstest.js --gpu` 8/8 通过（部署、巡逻移动、与机身保持距离、反射环境、循环声、起飞收回、无报错）；`pac9viewmodeltest` 22/22 通过；`test:smoke`、`test:gameplay` 通过。`npm test` 目前停在 `terrainheightfieldtest`，原因是另一个会话正在改 `planet.js` / `terrain-*`（地表重写 T 批次），与本轮无关。

注意：带 GPU 的浏览器测试不要和 SwiftShader 的 gameplay 测试并行跑，资源争抢会让开火时序检查误报。
