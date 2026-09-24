# Agent Note: noj-docs 面向读者的正确性与可读性审计（2026-09-24）

Status: implemented

## Problem

`noj-docs` 的文档在多次快速迭代后积累了多类问题，且此前几轮审计都以"事实正确性"
为目标，**没有人从人类读者视角评价可读性**：

1. **事实性漂移仍然存在**：如 `GET /api/v1/problems/:id/template` 被描述成"支持包模板
   下载"（实为编辑器初始代码模板）、`::: note` 非法容器（VitePress 无此容器，会渲染为
   字面文本）、`result.accept()` 分数示例双重放大、`backup` 裸命令被写成可用、
   `email_provider` 被误列为"运行时可改"（实为 bootstrap 只读）、`#435` 查无对应 issue 等。
2. **可读性普遍不足**：`standards/`、`system/` 两组容器标记数为 **0**；`operators/` 12 个
   页面仅 2 个容器标记；大量文档是"一堵墙文字"，关键前置条件/不可逆操作/禁止项没有任何
   视觉强调，读者扫读时无法定位重点。
3. **存在会误导读者的坏块**：`users/account.md`、`users/results.md`、`features/ranking.md`
   使用 `::: note`，在 VitePress 中整段渲染为普通文本（包括 `:::` 字面量），既丢失强调
   又污染排版。

## Decision

按**读者角色/主题分 7 组**派发并行子代理，每组「正确性审计 + 可读性改进 + 视觉评价」
三合一，直接落盘改进并产出审计报告：

| 组 | 范围 | 报告 |
|---|---|---|
| users | `docs/users/` | `dev-docs/audit/2026-09-24-docs-readability-audit/users.md` |
| operators | `docs/operators/` | 同目录 `operators.md` |
| problemsetters | `docs/problemsetters/` | `problemsetters.md` |
| standards | `docs/standards/` | `standards.md` |
| mechanisms | `docs/mechanisms/` | `mechanisms.md` |
| system | `docs/system/` | `system.md` |
| features | `docs/features/` | `features.md` |

统一规范固化为 `dev-docs/audit/2026-09-24-docs-readability-audit/RUBRIC.md`，其中两条
关键约束来自本次的真实教训：

- **接口语义必须先取证再落笔**：任何新增断言涉及 API/命令/字段/状态，必须先在源码定位到
  该符号并读实现；禁止望文生义。（真实反例：`GET /problems/:id/template` 被误写成
  "支持包模板下载"，实为编辑器初始代码模板——由人工复核发现，非子代理发现。）
- **视觉评价用无头 Chrome 截图**（`--virtual-time-budget=12000`，VitePress 客户端渲染必须
  等待水合，否则截到空白），而非依赖不可用的远程浏览器工具。

同时明确：不改源码、不改侧边栏、不增删页面、由编排者统一构建（避免并行 `docs:build` 互踩
`dist/`）。

## Alternatives considered

- **单代理串行审计全部 55 页**：覆盖面太广，单代理上下文与时间成本过高，且不同角色组之间
  无共享状态，天然适合并行。
- **只审计不修改**：用户明确要求"审计 + 应用改进"，且坏块（`::: note`）属于确定性缺陷，
  不修则读者持续受损。
- **让子代理各自运行 `docs:build` 验证**：7 个进程会并发写 `noj-docs/docs/.vitepress/dist/`，
  互相覆盖导致假失败；改为编排者统一构建 + 全仓链接/容器校验。
- **保留 `::: note` 并自定义样式支持它**：等于给一个非标准容器开特例，与 VitePress 官方
  容器集（tip/info/warning/danger/details）冲突；改为统一替换为标准容器。

## Consequences

- 63 个文件变更（2144 insertions / 527 deletions），覆盖 55 个文档页面 + 7 份报告 + 1 份
  RUBRIC。
- 确定性缺陷修复：3 处非法 `::: note` 全部替换；`problemsetters` 三处"支持包模板下载"
  错误措辞修正；`mechanisms/runtimes.md` 语言声明与 `judge-model.md` 术语校正；`operators`
  的 CLI 命令/只读配置/演练步骤等修正。
- 可读性显著提升：`standards`、`system` 从零容器提升到每页 1–5 个；`operators` 从 2 个
  容器标记提升到 20 组；全站容器均成对闭合。
- **遗留问题未处理**（已在各报告登记，需人拍板）：`memory_kb` 白名单缺失（源码侧）、
  `samples` 死字段、`deploy/monitoring/**` 注释指向已弃用脚本（范围外文件）、签到活跃榜
  无 UI 入口、`system/storage.md` 与 `operators/storage.md` 定位重叠等。
- 报告为时点记录（2026-09-24 快照）；后续若源码继续演进，文档仍可能再次漂移，本轮未引入
  自动化门禁（语义漂移无法由静态检查覆盖）。
