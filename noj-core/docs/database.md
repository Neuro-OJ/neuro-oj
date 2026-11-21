# 数据库与迁移（noj-core）

> 单一事实源是 Drizzle schema（`src/shared/db/schema.ts`）与 `drizzle/` 下的
> SQL。迁移安全属于仓库级红线，见 [`../../AGENTS.md`](../../AGENTS.md)。

## 1. 迁移流程

| 步骤      | 做法                                                             |
| --------- | ---------------------------------------------------------------- |
| 改 schema | 修改 `src/shared/db/schema.ts` 等 Drizzle 定义                   |
| 生成 SQL  | `deno task db:generate` → `drizzle/NNNN_*.sql` + `drizzle/meta/` |
| 人工审阅  | 检查 SQL 能否在存量库上执行、是否可重放                          |
| 执行      | `deno task db:migrate`（HTTP 启动只做只读兼容检查，不执行 DDL）  |
| 验证      | `deno task check` 与迁移相关测试                                 |

- 迁移严格按编号追加，Drizzle migrator 按 `drizzle/` 顺序执行。
- `_journal.json` 与 SQL 必须一致；**禁止手改 `drizzle/meta/_journal.json`**，
  也禁止改 `deno.lock`。
- 禁止直连生产库改 schema。
- 新表/新字段必须走 `deno task db:generate`，不要手写 journal 条目。

## 2. 三步式迁移（强制）

存量库升级时，一步到位的 `ADD COLUMN ... NOT NULL` 必失败；空库无法发现。
必须拆成三步，并保证 SQL 能作用于已有数据：

```sql
-- 1) 先加可空列
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS effective_score bigint;
-- 2) 回填历史行（大表分批，避免长事务）
UPDATE submissions SET effective_score = score WHERE effective_score IS NULL;
-- 3) 回填完成后收紧
ALTER TABLE submissions ALTER COLUMN effective_score SET NOT NULL;
```

仓库根的
[`../../scripts/check-migration-safety.ts`](../../scripts/check-migration-safety.ts)
会静态拒绝「向已存在表加 NOT NULL 列且不带 DEFAULT」的写法；三步式不会被误报。
带 `DEFAULT` 的加列在 PostgreSQL 11+ 是安全的；不要绕过门禁。

## 3. schema 关键约定

| 事实                      | 约定                                                         |
| ------------------------- | ------------------------------------------------------------ |
| `users.role`              | 平台角色，单值列 + CHECK，仅 `user` / `admin`                |
| `domain_memberships.role` | 域内角色，单值列 + CHECK，仅 `member` / `educator` / `admin` |
| `domains.owner_id`        | 域负责人，优先于成员角色                                     |
| 分值                      | ×100 整数存储，读写用 `scoreToDb` / `scoreFromDb`            |
| 时间戳                    | ISO 8601 文本                                                |
| 草稿                      | `problem_drafts.revision` 乐观锁；缺失 428，版本过时 409     |

## 4. 题目版本与成绩

- 四概念分离：身份 `problems`、不可变版本 `problem_versions`、提交时版本
  `submitted_version_id`、评测尝试 `evaluation_attempts`。
- 内容事实源是共享草稿 `problem_drafts`：`revision` 乐观锁，草稿缺失返回 428，
  版本过时返回 409；发布才写版本。
- 有效成绩由 `submission_version_results` + `selectEffectiveResults`
  （[`src/shared/versioning/effective-results.ts`](../src/shared/versioning/effective-results.ts)）
  物化。
- 用户文档：[problem-versioning.md](../../noj-docs/docs/features/problem-versioning.md)。

## 5. 提交与评测状态

- 提交状态机：`pending → [judging, error]`，`judging → [finished, error]` 为
  终态；派发**暂时**失败时 `pending` 会保持，不直接进 `error`。
- 评测尝试终态不可覆盖；重测新建 attempt（递增 `sequence`，旧行标记
  `superseded`）。
- 评测写入先落库再推 MQ；可重试的入队失败（Redis 暂时不可用、队列已满）由后台
  派发任务/恢复扫描沿用同一 attempt 退避重试，只有**永久**失败（消息超限、队列
  布局需升级、准入事实无法重建）才标记 `error`（attempt 终态
  `DISPATCH_FAILED`）。
- `sequence` 只在源提交行锁内分配，任务封套与落库值必须一致。
