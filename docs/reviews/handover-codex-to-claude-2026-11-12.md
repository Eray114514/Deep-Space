# Codex → Claude 主控交接

日期：2026-11-12  
依据：用户决策（主控改为 Claude，Codex 转为验收）  
来源会话：Codex `01a0fd3e-b2f7-7a40-a953-0a2a03c665a6`（记录在 `~/.codex/sessions/2026/10/15/`，更早部分在 `2026/10/02/` 的 `.zst`）  
新分工：[模型协作约定](../model-collaboration.md)

本说明只记交接时点的状态，不替代[待办与难度表](../remaining-work-difficulty.md)和[总路线图](../optimization-roadmap.md)。内容取自 Codex 会话的最后几轮对话和仓库文档，**主控没有独立复跑其中任何数据**。

## 交接时点

- `main` 在 `bfb34da`（F6 连续 2K 漫游、200 km 交接、基线清理与 B4 交接）。工作区唯一未跟踪文件是 `docs/visual-targets/b4-first-cloud-shot.html`。
- Carbon 完成了 F0–F6 的底层攻关，证据在 [F 阶段收官基线](../baselines/foundation-phase-f-2026-11-12/README.md)。Codex 最后的判断是底层重构约 90%，可以进入收尾。
- `npm test` 能跑到最后，仍因已暂缓的宇宙锁退出。浏览器 smoke 和 B5 传输测试在 Codex 复跑时通过。

## Codex 留下、尚未做的事

Codex 最后一轮说要先做一轮默认设置下的真实输入飞行，从白天下降测到落地步行，同时看实际提交帧和画面。这一轮没有执行。它要回答三个问题：

1. **步行约 9 FPS**。Carbon 的同星脚本里步行样本只有约 9 FPS，且主要按浏览器回调计时。需要判断是场景特例、默认路径问题，还是底层瓶颈。
2. **冷启动口径不一致**。Carbon 报告默认 2K 冷启动约 29 秒，Codex 独立复跑的首个可操控云帧约 50 秒（此前同类测试 106 秒）。需要同口径复现。
3. **Balanced 档云采样上限**。该档降低了部分云采样上限，固定输入下 HDR 零差。还缺一组正常白天下降的画面对照，确认薄云、长切线和逆光层次撑得住。

Codex 的意见是：如果这一轮没有发现迫使云接口返工的问题，就可以开始 B4 生产版首族云。多设备签收和 TAA 默认化随后推进。

## B4 的两份起点

- [F 阶段 → B4 恢复交接](f-phase-b4-handoff-2026-11-12.md)：底层已就绪的能力，以及 FXC 内联与 VGPR、逐字符契约测试、B5 有序传输三条护栏。
- `docs/visual-targets/b4-first-cloud-shot.html`：主控此前作为子 agent 做的层积云小样，含低轨对照和 56 秒下降穿云两个镜头。开场画面亲眼确认过；掠云顶、云内、云底只做了像素读回，没有肉眼看过，`?t=` 冻结参数也未在正常浏览器里验证。小样用的星球半径和云层厚度是为可读性取的，不是游戏内数值。

## 遗留的额外目录

Codex 先后在仓库旁建了三个工作树，用户明确不希望文件夹变乱：

| 目录 | HEAD |
|---|---|
| `Game/深空-old51c` | `51c7c11`（旧版观感基准） |
| `Game/深空-stage-a-review-99c1c48` | `e6b3987` |
| `Game/deep-space-carbon-f3-20261111` | `07e24d8` |

三者都还登记在 `git worktree list` 里。交接时没有动它们，是否清理由用户决定。此后默认只在主目录工作。

## 工具现状

- Codex CLI `0.167.0`，默认 `gpt-6.1-sol` / `high`。
- `dshx --status` 显示桥接插件在运行，默认 `gemini-4-carbon` / `high`，返回里 `authenticated` 为 `false`，下次派发前需确认是否影响调用。
- Claude Code CLI 在 2026-11-11 重新安装并登录过（Codex 当时从它那边调不通，原因是登录状态）。主控改为 Claude 后不再需要这条路径。

## 本次交接没有做的事

没有推进任何任务进度，没有派发 Codex 或 Carbon，没有改 `src/`、`tools/` 或 `AGENTS.md`，没有提交。
