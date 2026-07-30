## Context

Neuro OJ 目前缺少竞赛/考试系统——OJ 平台最核心的功能之一。现有基础设施（用户系统、题目管理、提交评测、Redis MQ、SSE 推送）已成熟，为竞赛系统提供了坚实基础。本次设计需与现有架构保持一致：

- **后端**: Deno 2 + Hono + Drizzle ORM + PostgreSQL
- **实时通信**: Redis PubSub → local EventEmitter → SSE
- **认证授权**: JWT + RBAC（`resource:action` 权限模型）
- **模式**: routes → services → db，AppError 继承体系

## Goals / Non-Goals

**Goals:**
- 支持 ICPC（罚时制）、IOI（实时反馈总分制）、OI（隐藏排名总分制）三种赛制
- 公开注册 + 管理员邀请双模式参赛
- 竞赛内提交与普通提交共享基础设施，通过 `contest_id` 区分
- ICPC 支持封榜（scoreboard freeze），参考 DOMjudge 标准
- 竞赛提交是否计入全局排名可配置
- SSE 实时推送排名更新（限流 ≥ 5s）

**Non-Goals:**
- 团队赛（多用户组队）
- 虚拟参赛（赛后独立时间窗口模拟）
- 代码相似度检测（MOSS/JPlag）
- Rating 系统（Elo 等级分）
- Hack/互测机制
- 灵活时间（HydroOJ 式自选时间窗口）
- 多语言限制（沿用题目配置）

## Decisions

### 1. 赛制配置使用 JSON 字段而非独立列

**选择**: `contests` 表新增 `config JSONB NOT NULL DEFAULT '{}'` 字段，赛制特定配置（封榜时间、罚时分钟数、排名可见性等）全部存储在此字段中，仅用 `type VARCHAR` 标识赛制类型。

**config 结构**（按赛制）:
```json
// ICPC
{ "penalty_minutes": 20, "freeze_time": "2026-08-01T10:00:00Z", "unfreeze_after_end": true }

// IOI
{ "show_ranking_live": true }

// OI
{ "show_ranking_live": false }
```

**理由**:
- 后续扩展新赛制（如 Codeforces 的 dynamic scoring、Hack 机制）无需 ALTER TABLE
- 遵循项目先例：`problems` 表已有 `runtime_config JSONB` 字段存储双容器运行时配置
- `type` 枚举列决定 config 的 schema，应用层校验配置结构
- 相比独立列（如 `freeze_time`），JSON 字段避免了大量 NULLable 列

**替代方案**: 每个赛制配置项独立列。缺点：新赛制需要 ALTER TABLE + 迁移，列数膨胀，大部分列对特定赛制为 NULL。

### 2. `contest_id` 放在 submissions 表而非独立表

**选择**: 在 `submissions` 表新增 NULLable `contest_id` 列。

**理由**:
- 复用现有提交基础设施（创建、评测、结果写入），改动最小
- 查询简单（单表 JOIN），无需 UNION 两个表
- NULL = 普通提交，非 NULL = 竞赛提交，语义清晰
- 其他 OJ 系统（HydroOJ、DOMjudge）也采用此模式

**替代方案**: 独立 `contest_submissions` 表。缺点：需要复制提交逻辑，查询需 UNION，维护成本高。

### 3. 排名计算用原始 SQL 而非 ORM

**选择**: ICPC 和 IOI 排名直接在 `services/contest-ranking.ts` 中用 `db.execute(sql\`...\`)` 计算。

**理由**:
- ICPC 排名涉及 DISTINCT ON、窗口函数、多层 CTE，Drizzle ORM 表达能力不足
- 现有 `services/rankings.ts` 已有 materialized view + 原始 SQL 的先例
- 初期参与者规模（< 1000 人 × < 10 题）下，实时 SQL 计算完全可行

**替代方案**: 物化视图 + 定期刷新。缺点：实时性差，封榜/解封逻辑复杂。

### 4. 竞赛状态动态计算，不存 DB

**选择**: `computeContestStatus(startTime, endTime)` 在读取时根据当前时间动态计算 `pending | running | ended`。

**理由**:
- 避免定时任务 / cron 维护状态
- 无状态漂移风险（时钟不同步、任务未触发等）
- 查询时判断简单：`Date.now() < start → pending; < end → running; else → ended`

### 5. 封榜在前端 + 后端双重实现

**选择**: `getContestRanking` 接收 `isAdmin` / `viewerId` 参数，非 admin 在封榜期间只返回 `config.freeze_time` 之前的提交结果。封榜在 `end_time` 后**自动解封**。

**理由**:
- 前端无法保证数据可信（API 请求可直接被调用）
- 管理员始终可见完整排名
- 参考 DOMjudge 的实现：freeze_time 检查的是 submission.created_at 而非 judge 时间
- 封榜后参赛者自身行仍然更新（能看到自己最新结果），但他人排名冻结
- 自动解封简化管理流程，无需管理员手动操作

### 6. 竞赛题目创建时一次性绑定

**选择**: `createContest` 时同时传入 `problems` 数组，在事务中一并插入。

**理由**:
- 简化 API（一次请求完成创建 + 绑题）
- 事务保证原子性
- 编辑时通过 `updateContest` 可重新设置题目列表（DELETE + INSERT 策略）

### 7. Phase 4 才做 Clarifications

**选择**: `contest_clarifications` 表在 schema 中定义但 Phase 1-3 不实现 API。

**理由**: MVP 聚焦核心流程（创建 → 注册 → 提交 → 排名），答疑可后续补充。表定义提前写入 schema 避免后续迁移复杂化。

## Risks / Trade-offs

- **[性能] 排名实时计算** → 初期不做缓存。若参与者 > 1000 人时排名查询变慢，后续可加 30s 内存缓存或物化视图。排名 SQL 已设计为单查询，利用了 `contest_id + problem_id + user_id` 复合索引。

- **[数据一致性] 竞赛提交失败后回滚** → 复用现有 `createSubmission` 的事务模式：先写 DB（status: pending），再推 MQ。MQ 推送失败时回写 status: error。竞赛提交仅多一个 `contest_id` 字段，不改变此流程。

- **[安全] 竞赛期间代码可见性** → 竞赛提交的 code 仅提交者和 admin 可见（复用现有 `getSubmission` 的 owner/admin 检查逻辑）。竞赛结束后，`contest_id` 的提交自动变为公开可查（同普通提交）。

- **[正确性] 排名 SQL 复杂度** → ICPC 排名的 CTE 较复杂（DISTINCT ON + 时间比较 + COALESCE 聚合）。需通过人工构造已知排名的测试数据集验证。建议在 `tests/services/contest-ranking.test.ts` 中覆盖：单人单题 AC、多人多题、封榜后边缘情况。

## Migration Plan

1. 生成 Drizzle 迁移文件（`deno task db:generate`）
2. 执行迁移（启动时自动）
3. 反向兼容：所有新增表不影响现有功能；`submissions.contest_id` 为 NULLable，现有数据不受影响
4. 回滚：删除新增的 4 张表 + 删除 submissions.contest_id 列即可

## Open Questions

- (已确认) 三种赛制都做
- (已确认) 公开注册 + 管理员邀请双模式
- (已确认) `affect_global_ranking` 可配置
- (已确认) 后端先行，前端 Phase 3
- (已确认) ICPC 封榜在 `end_time` 后自动解封
