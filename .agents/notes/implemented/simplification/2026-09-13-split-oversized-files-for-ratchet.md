# Agent Note: 拆分两个超限巨型文件以消解规模棘轮告警

Status: implemented

## Problem

日志重构栈（`fix/log-conventions-review-findings`）在 rebase 到新 `main` 后，
`scripts/check-file-size.ts` 报出两处**棘轮增长**，导致 `scripts/check-ci.ts`
整体失败：

- `noj-core/src/domains/messaging/services/messages.ts`：基线 1515 → 1517（+2）
- `noj-core/src/shared/config/settings-registry.ts`：基线 1360 → 1380（+20）

两处增长都不是 rebase 引入的：栈本身的提交（rebase 前的 `d46e2ce5`）就已经是
1517 / 1380 行。它们分别来自：

- LogTape 迁移把 `import { logger } from ".../logging.ts"` 换成
  `import { getLogger } from "@logtape/logtape"` + 空行 + 模块级
  `const logger`， 净增 2 行；
- 新增 `LOG_COLOR` / `NO_COLOR` 两个 bootstrap 配置项，净增 20 行。

棘轮门禁的注释写明规则：「数值 = 本门禁建立时的实际行数；**只允许下调，
不允许上调**。拆分后请把数值改成新的实际行数（或直接删除条目）」。因此直接上调
基线是规避门禁，不是修复；这两处也确实到了该拆的规模。

## Decision

按门禁给出的路径**拆分文件**，只移动数据的物理位置，不改变任何对外语义。

1. `settings-registry.ts`（1380 行）→ 按 scope 拆成两个模块：
   - `settings-registry.ts`（946 行）：类型、`SettingDefinition`、
     `validateRegistry()` 等函数 + 69 个 runtime 条目；
   - `settings-registry-bootstrap.ts`（458 行，新增）：45 个 bootstrap 条目。
   - `CONFIG_DEFINITIONS` 用展开语法 `...BOOTSTRAP_CONFIG_DEFINITIONS`
     按原顺序拼接， 对外仍是**单一数组、单一事实源**。

2. `messages.ts`（1517 行）→ 按职责拆成三个模块：
   - `messages-shared.ts`（70 行，新增）：两侧都要用的最小内核
     （`assertParticipant`、`MAX_MESSAGE_LENGTH`、`REACTION_EMOJIS`）；
   - `messages-conversation-actions.ts`（414 行，新增）：对单条消息/会话的交互
     （reaction、编辑、撤回、会话备注与免打扰、清空记录）；
   - `messages.ts`（1102 行）：消息创建与查询，并**再导出**上述两个模块的公开
     API， 保证 `services/messages.ts` 仍是对外唯一入口。

3. `scripts/check-file-size.ts`：两个条目按规则**移除**（已降到 1200
   行阈值以下）， 并在原位留下拆分去向的注释。

4. `noj-core/scripts/check-config-usage.ts`：把新增的
   `settings-registry-bootstrap.ts` 一并纳入 `NON_CONSUMER_PATTERNS`。
   这一步是必须的——注册表文件里全是键名字面量，若不排除，会被当成「读取点」，
   让所有死键自动通过（正是该门禁加固说明里点名的假绿灯形态）；为此把原正则
   `settings-registry\.ts` 放宽为 `settings-registry(-bootstrap)?\.ts`。

## Alternatives considered

- **直接上调 `SIZE_BASELINE`**：门禁注释与架构评审 §3.2 都明确禁止，且会把这个
  门禁退化成装饰。两处增长虽小，但棘轮的意义正是「不因为"只多几行"就放行」。
- **只拆 `settings-registry.ts`（+20 的那处），放过 messages.ts 的 +2**：门禁对
  任何增长都失败，放过就仍是一片红；且 1516 行的 messages.ts 本就在拆分清单上。
- **把 bootstrap 条目改成 JSON/YAML 数据文件**：会让 `SettingDefinition` 失去
  类型检查，且 `check-config-usage` 等工具依赖 TS 字面量，得不偿失。
- **`messages.ts` 按「查询 / 变更」两分**：查询函数之间共享大量 CTE 与
  `executeRows` 辅助，切开会引入比现在更多的内部耦合面；按「共享内核 / 交互动作
  / 创建与查询」三分更贴合真实依赖。

## Consequences

- 两个文件降到 946 / 1102 行，均低于 1200 行阈值，`SIZE_BASELINE` 从 5 条减到 3
  条。
- 语义等价已用机器证明：对比拆分前后 `CONFIG_DEFINITIONS` 的 `JSON.stringify`
  结果，**114 个条目顺序与内容完全一致**（69 runtime + 45 bootstrap）。
- `messages.ts` 的 20 个公开导出全部保留；`messaging` 域 66 个测试、 `system` 域
  116 个测试全绿。
- `dev-docs/engineering/event-catalog.md` 是生成物，因 `publishSseEvent` 调用点
  随代码移到了新模块而需重新生成（`deno run -A scripts/gen-event-catalog.ts`）；
  这正是该门禁「生成物过期即失败」的预期行为。
- 后续若要继续拆这两个文件，`settings-registry-bootstrap.ts` 还能按 「基础设施 /
  密钥 / 日志 / OAuth」等小节进一步细分。
