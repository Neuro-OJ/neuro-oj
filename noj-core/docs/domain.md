# 领域不变量（noj-core）

> 只记跨模块、容易改错的业务约束；各模块 README / 路由 / 测试是实现细节来源。

## 1. 题目版本

- 四概念分离：身份 `problems`、不可变版本 `problem_versions`、提交时版本
  `submitted_version_id`、评测尝试 `evaluation_attempts`。
- 内容事实源是共享草稿 `problem_drafts`：`revision` 乐观锁，草稿缺失返回 428，
  版本过时返回 409；发布才写版本。
- 有效成绩由 `submission_version_results` + `selectEffectiveResults`
  （[`src/shared/versioning/effective-results.ts`](../src/shared/versioning/effective-results.ts)）
  物化。
- 用户文档：[problem-versioning.md](../../noj-docs/docs/features/problem-versioning.md)。

## 2. 竞赛

- **公开赛题目保密**：判定单一真相源为 contest 域的
  [`problem-secrecy.ts`](../src/modules/contests/services/problem-secrecy.ts)；
  新门控**禁止**再手写时间窗口比较。
- **竞赛提交隐私**：进行中竞赛排行榜仅返回本人一行；SSE 不下发他人的 `user_id` /
  `submission_id`。

## 3. Redis MQ 与评测协议

- 向 noj-judge 分发评测任务，并消费结果落库。
- 队列：`noj:judge:queue:{high,medium,low}` 下发任务；`:processing` 由 sweeper
  超时重投；`noj:judge:results` 回流结果。
- 顺序：**先写 DB，再推 MQ**：提交、attempt 与可恢复的 `evaluation.dispatch`
  任务同事务落库，提交后再推队列（见
  [`dispatch-handlers.ts`](../src/modules/application/dispatch-handlers.ts)）。
- Redis **暂时**不可用（`network` / `capacity`）时 submission 保持
  `pending`：后台派发任务沿用同一 attempt / run identity 按退避重试（5
  秒起、上限 5 分钟）；pending 恢复扫描也会补派。
- 只有**永久**入队失败（消息超限、队列布局需升级、准入事实无法重建）才写
  `DISPATCH_FAILED`，把 attempt 标成 `platform_error`。
- 评测脚本（AI 题 dual 双容器）输出 `---RESULT---` + `{score, details}`。
- 协议 v3 携带 `attempt_id` / `problem_version_id` / `run_id` / `result_kind`；
  `details.cases[].hidden` 必须为布尔，隐藏用例不得输出输入 / 期望 / 实际输出。
- 提交状态机与 attempt 不覆盖规则见
  [`database.md`](./database.md#5-提交与评测状态)。

## 4. 限流与限制

- 登录 / 搜索限流：Redis 固定窗口；命名空间 `login` / `pwchange` / `tfa` 与
  搜索桶互相隔离。
- `RATE_LIMIT_ENABLED` 是总开关；`NOJ_ENV=test` 强制关闭。
- 输出截断 8 KB（`MAX_OUTPUT_LENGTH`）；代码长度上限 100 KB。
- 分页默认 `page=1`、`per_page=20`、最大 100。

## 5. 相关

- 评测侧实现：[`../../noj-judge/AGENTS.md`](../../noj-judge/AGENTS.md)
- 安全与防御基线：
  [`../../dev-docs/engineering/defensive-patterns.md`](../../dev-docs/engineering/defensive-patterns.md)
