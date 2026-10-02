# 文档入口

| 文档 | 负责内容 |
|---|---|
| [优化路线图](optimization-roadmap.md) | 全局目标、批次依赖、A 验收基线和 C/D/E/R 后续 |
| [渲染基础改进与交接](render-foundation-improvements.md) | 基础排查、分轮施工与进度；植被索引/远景局部精度，后续近景精度与整帧预算 |
| [未完成任务难度评估](remaining-work-difficulty.md) | 小阶段拆分、难度、前置条件与 agent 交接建议；进度仍以各原计划为准 |
| [云与大气计划](cloud-atmosphere-rewrite.md) | B 唯一规格、进度和返工顺序 |
| [阶段 4 云演进](cloud-phase4-volume-march.md) | B 的天气接线、云种/形态、采样实施清单 |
| [B4 天气接线契约](cloud-weather-contract.md) | 首族、可执行坐标/地形查询、内容/时间语义和消费者迁移位置 |
| [介质、深度与时域接口](medium-render-contract.md) | B0 冻结的目标语义；约束 B5/B4/B7，不冒称生产 API 已完成 |
| [B0 基线与交接](baselines/b0-2026-09-20/README.md) | 可复现矩阵、连续帧、传输参考、已知缺陷和 B5 施工边界 |
| [B5 传输与照明交接](baselines/b5-2026-09-21/README.md) | 解析/GPU 参考、生产画面、近似边界与 B4 施工约束 |
| [B4 生产天气迁移交接](baselines/b4-weather-2026-09-26/README.md) | 真实地形与共享天气输入、GPU 对照、当前玩家矩阵和首族后续边界 |
| [视觉验收协议](visual-targets/README.md) | S1–S4 机位、五维评审、动态/性能和记录格式 |
| [2026-09-20 B 审查](reviews/cloud-atmosphere-2026-09-20.md) | 本轮代码核对、实测、证据边界和返工理由 |
| [B 基础修复与交接](reviews/cloud-atmosphere-foundation-2026-09-20.md) | 已落地修复、复现命令与继续施工的边界 |
| [发布宇宙与重筛](world-curation.md) | 内容身份、锁与重构结束后的筛选流程 |

过期方案和过程日志保存在 Git，精简前版本为 `294c204`。`curation/` 图片是历史候选资料，`visual-targets/` 是目标参考，均不能替代当前源码的生产画面。全量重构期间宇宙锁延期，按用户要求在重构验收后重筛。
