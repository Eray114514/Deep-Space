# ASTRAL FRONTIER · 星渊边界

原创桌面浏览器 3D 深空探索游戏。包含巨型行星近轨飞行、连续大气进入、高空与地表飞行、着陆/离船、第一人称探索、采集战斗、512 节点星图和定向跃迁演出。

## 启动

```bash
npm install
npm run dev
```

打开终端给出的本地地址，点击“开始探索”。推荐 Chrome 或 Edge，并允许网页锁定鼠标。

## 操作

- 飞船：鼠标控制船头，`W/S` 推进/制动，`A/D` 横滚，`Shift` 或鼠标右键加力，`Ctrl` 精确操控，`F` 着陆/互动，`Tab` 星图。
- 地表：鼠标观察，`WASD` 移动，`Shift` 奔跑，`V` 扫描，鼠标左键采集，`F` 登船。
- 菜单：`Esc` 释放鼠标或暂停。

## 验证

```bash
npm run build
npm test
npm run test:e2e
```

主飞船和轨道行星影像均经过 Web 端整理与压缩；完整作者、来源、许可和修改记录见 [THIRD_PARTY_ASSETS.md](./THIRD_PARTY_ASSETS.md)。地表生成、UI、声音合成和玩法代码为本项目原创内容。
