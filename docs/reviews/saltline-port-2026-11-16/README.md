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
