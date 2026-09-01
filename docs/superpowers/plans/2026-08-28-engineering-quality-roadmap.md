# NOJ 工程质量提升路线图 总实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通过分阶段治理，使 NOJ 的文档/注释不漂移、测试能抓住真问题、架构可替换、决策可追溯、SSE 状态不丢。

**Architecture:** 采用“护栏 → 测试/CI → 架构演进 → 固化流程”四阶段。每阶段有独立可交付物；SSE 事件日志作为 Phase 2 的核心专项，用 PostgreSQL 全局 seq 事件表替代纯 Redis Pub/Sub 通知。

**Tech Stack:** Deno 2 + Hono（core/llm-gateway）、Nuxt 4 + Vue 3（ui）、Rust + Tokio + Docker（judge）、PostgreSQL 16、Redis 7、GitHub Actions、lefthook、Vitest（用于未来前端测试扩展）。

**Spec:** `docs/superpowers/specs/2026-08-28-engineering-quality-roadmap-design.md`

## Global Constraints

- 所有提交必须 GPG 签名，使用 jj/git 配置的签名密钥。
- 提交信息遵循 Conventional Commits，description 使用中文。
- 功能性变更须先写设计文档（`docs/superpowers/specs/`）并包含 Agent Note。
- 禁止直接推送 `main`，所有变更通过 PR 合入。
- 代码注释使用中文，标识符使用英文。
- noj-core/llm-gateway 测试使用 `deno task` 封装命令，不手拼 `deno test`。
- noj-judge 测试使用 `cargo fmt`、`cargo clippy`、`cargo nextest`/`cargo test`。
- 新环境变量必须同步 `.env.example` 与 `scripts/dev/env.example`。
- 本总计划是里程碑级；每个里程碑启动时，用 writing-plans 生成该里程碑的详细任务级实施计划。

---

## Phase 0：止血与护栏

**目标：** 让文档、注释、决策记录不再继续腐烂，并建立本地快检。

### Milestone 0.1：决策记录制度

**Files / Dirs:**
- Create: `.agents/notes/README.md`
- Create: `.agents/notes/implemented/AGENTS.md`
- Create: `scripts/verify-agent-note-format.ts`
- Modify: `AGENTS.md`（加入“非平凡 PR 必须带 Agent Note”规则）
- Modify: `.github/pull_request_template.md`

**Deliverables:**
- Agent Note 模板与目录约定：`{lifecycle}/{class}/yyyy-mm-dd-topic-title.md`。
- 格式校验脚本：校验 `Status`、`Problem`、`Decision`/`Proposal`、`Alternatives considered`、`Consequences` 等章节。
- PR template 增加 Agent Note 检查项。

**Acceptance:**
- 新 Agent Note 通过 `deno run -A scripts/verify-agent-note-format.ts`。
- 非平凡 PR 模板要求包含 Agent Note。

### Milestone 0.2：导出 JSDoc 门禁

**Files:**
- Create: `scripts/verify-export-jsdoc.ts`
- Modify: `noj-core/deno.json`（新增 `check:jsdoc` task）
- Modify: `noj-llm-gateway/deno.json`（新增 `check:jsdoc` task）
- Modify: `.github/workflows/ci.yml`（新增 static 检查 job）

**Deliverables:**
- 脚本扫描 `noj-core/src`、`noj-llm-gateway/src` 的导出函数/类，要求有 `/** */`。
- CI 在 static 阶段运行。

**Acceptance:**
- 未注释导出使 CI 失败。
- 现有导出覆盖率不倒退：noj-core ≥ 62.9%，noj-llm-gateway ≥ 80.6%。

### Milestone 0.3：文档链接门禁

**Files:**
- Create: `scripts/verify-md-links.ts`
- Modify: `.github/workflows/ci.yml`

**Deliverables:**
- 扫描仓库 Markdown 相对链接与锚点，检查死链/坏锚点。
- 排除 `node_modules`、`.nuxt`、`.output`、`dist`。

**Acceptance:**
- 死链/坏锚点使 CI 失败。
- 当前 noj-docs 已知死链被修复或纳入豁免。

### Milestone 0.4：根文档瘦身

**Files:**
- Modify: `AGENTS.md`（压缩为“规则 + 链接”）
- Modify: `noj-core/CLAUDE.md`、`noj-ui/CLAUDE.md`、`noj-judge/CLAUDE.md`（承接下沉内容）
- Create: `docs/engineering/README.md`

**Deliverables:**
- 根 AGENTS 减少至少 40% 行数。
- 详细内容迁移到模块 CLAUDE 或 `docs/engineering/`。

**Acceptance:**
- 根 AGENTS 所有保留规则都有对应详细文档链接。
- `verify-md-links` 通过。

### Milestone 0.5：核心工程文档

**Files:**
- Create: `docs/engineering/testing.md`
- Create: `docs/engineering/defensive-patterns.md`
- Create: `docs/engineering/development.md`

**Deliverables:**
- testing.md：测试分层、命令、覆盖率策略、真实入口 smoke 约定。
- defensive-patterns.md：正交结果上报、cleanup quiescence、ZIP 安全、env scrub、symlink 处理等。
- development.md：本地开发、提交前检查、CI 说明。

**Acceptance:**
- 三份文档与当前代码/命令一致。
- 根 AGENTS 链接到这三份文档。

### Milestone 0.6：清理已知漂移

**Files:**
- Modify: `README.md`、`AGENTS.md`、`noj-docs/**`（按审计清单）
- Modify: `noj-core/src/lib/env-snapshot.ts`、`noj-ui/composables/useMessages.ts`（注释-实现不一致）

**Deliverables:**
- 修复 8 月审计 docs 真阳性清单。
- 修复已知注释与实现不一致。

**Acceptance:**
- 审计 `docs/audit/2026-08-15-noj-audit/docs.md` 中的 28 条 docs 问题关闭或标注已修。
- `env-snapshot`、`useMessages` 注释与行为一致。

### Milestone 0.7：本地快检

**Files:**
- Create: `lefthook.yml`
- Modify: `package.json` 或 `deno.json`（如无根 package.json 则新建 `scripts/install-lefthook.mjs`）
- Modify: `.github/workflows/ci.yml`（确认 CI 仍全量）

**Deliverables:**
- pre-commit：staged fmt/lint/whitespace。
- pre-push：typecheck（core/ui/judge/llm-gateway 对应入口）。

**Acceptance:**
- 本地提交前快检完成，CI 全量不受影响。

---

## Phase 1：测试与 CI 加固

**目标：** 让测试真正覆盖“真实入口”和“关键行为”。

### Milestone 1.1：集中 Gate Runner

**Files:**
- Create: `scripts/check-all.ts`
- Create: `scripts/check-ci.ts`
- Modify: `.github/workflows/ci.yml`

**Deliverables:**
- `check-all`：fmt + lint + typecheck + 相关测试 + 文档链接 + JSDoc 门禁。
- `check-ci`：CI 使用的静态/覆盖率/消费者 lanes。

**Acceptance:**
- 本地一条命令跑完相关检查。
- CI 复用同一 runner，不再散落裸命令。

### Milestone 1.2：覆盖率门禁

**Files:**
- Modify: `noj-core/deno.json`、`noj-llm-gateway/deno.json`、`noj-ui/deno.json`、`noj-judge/Cargo.toml`
- Create: `scripts/coverage-report.ts`
- Modify: `.github/workflows/ci.yml`

**Deliverables:**
- 阈值：noj-core ≥ 75%、noj-judge ≥ 80%、noj-llm-gateway ≥ 80%、noj-ui 关键 composables ≥ 60%。
- CI coverage job 低于阈值失败。

**Acceptance:**
- CI 有覆盖率报告与阈值检查。
- 新代码不会显著降低模块覆盖率。

### Milestone 1.3：真实入口 Smoke

**Files:**
- Modify: `noj-judge/scripts/build-sdk-images.sh`
- Create: `noj-judge/tests/e2e_built_binary.rs`（或对应 smoke 脚本）
- Create: `noj-core/scripts/smoke-compiled.ts`
- Modify: `.github/workflows/ci.yml`

**Deliverables:**
- judge release binary / Docker 镜像真实入口 smoke。
- core `deno compile` 产物启动 smoke。

**Acceptance:**
- 发布物入口被 CI 覆盖；入口缺失/启动失败会使 CI 失败。

### Milestone 1.4：LLM 回放测试

**Files:**
- Create: `noj-llm-gateway/tests/replay/`
- Create: `noj-llm-gateway/scripts/record-replay.ts`
- Modify: `noj-llm-gateway/deno.json`

**Deliverables:**
- 录制-回放快照：无 key 可跑，有 key 可更新。
- 覆盖聊天补全、限流、额度审计关键路径。

**Acceptance:**
- `deno task test:snapshot` 无 key 通过。
- `deno task test:snapshot:record` 可更新快照。

### Milestone 1.5：with-key E2E 自跳

**Files:**
- Modify: `noj-tests/e2e/**`（增加 key 守卫 helper）
- Modify: `noj-llm-gateway/tests/**`

**Deliverables:**
- 真实 API 测试在无 key 时 self-skip，有 key 时运行。

**Acceptance:**
- 无 key CI 保持绿。
- 有 key 环境能跑真实 API 测试。

### Milestone 1.6：防御模式回归测试

**Files:**
- Modify: `noj-judge/src/dual/mod.rs`（如结果字段正交化）
- Create: `noj-judge/tests/defensive_patterns.rs`
- Modify: `noj-core/src/lib/storage/local.ts`、`s3.ts`（如路径/URL 校验）
- Create: `noj-core/tests/defensive-patterns_test.ts`

**Deliverables:**
- 超时+exit0 同时上报、cleanup quiescence、ZIP 路径穿越、env scrub、symlink 删除等回归测试。

**Acceptance:**
- 每个模式至少一个失败可证明的回归测试。

### Milestone 1.7：类型安全

**Files:**
- Modify: `noj-core/src/types/index.ts`
- Modify: `noj-judge/src/types.rs`
- Modify: 相关 services/routes 的 switch 分支

**Deliverables:**
- JudgeTask/JudgeResult/SubmissionStatus 改为 tagged union + `assertNever`。
- 跨边界 ID 品牌化。

**Acceptance:**
- 新增状态/事件类型时编译期强制覆盖所有分支。

---

## Phase 2：架构演进

**目标：** 让核心能力可替换、可观测、可组合；SSE 状态不丢。

### Milestone 2.1：Capability Seam

**Files:**
- Modify: `noj-core/src/lib/storage/`（接口/实现/消费者整理）
- Create: `noj-core/src/lib/llm-provider/`、`email-provider/`、`search-provider/`
- Modify: 相关 services 只依赖接口

**Deliverables:**
- Storage / LLM / Email / Search 四个 seam。
- 消费者不 import 具体实现。

**Acceptance:**
- 新增 provider 只新增实现文件，不改消费者。

### Milestone 2.2：事件域分离

**Files:**
- Modify: `noj-core/src/lib/event-bus.ts`
- Modify: `noj-core/src/services/submissions/**`
- Modify: `noj-ui/composables/useEventSource.ts`

**Deliverables:**
- 明确“DB/事件流 = 事实，SSE = 投影”。
- 提交生命周期以 DB/事件为准，SSE 只做增量投影。

**Acceptance:**
- 无第二份状态真相；SSE 与 DB 最终一致。

### Milestone 2.3：SSE 事件日志（核心专项）

**Files:**
- Create: `noj-core/drizzle/xxxx_sse_events.sql`
- Modify: `noj-core/src/db/schema.ts`
- Create: `noj-core/src/lib/sse-events.ts`
- Modify: `noj-core/src/lib/event-bus.ts`
- Modify: `noj-core/src/routes/sse.ts`
- Modify: `noj-core/src/mq/consumer.ts`
- Modify: `noj-core/src/services/submissions/**`、`queue.ts`、`stats-cache.ts`、`announcements.ts`、`messages.ts`、`notifications.ts`
- Modify: `noj-ui/composables/useEventSource.ts`
- Modify: `noj-ui/components/editor/EditorWorkspace.vue`
- Create: `noj-core/tests/sse-events_test.ts`
- Create: `noj-ui/tests/useEventSource_test.ts`

**Deliverables:**
- 新增 `sse_events` 表：`id BIGSERIAL`、`channel TEXT`、`payload JSONB`、`created_at`。
- 所有频道（submission / queue / stats / announcements / user / contest）写入同一张表。
- 写入与状态变更同事务；提交后发布 Redis。
- SSE 连接：注册订阅 → 推 snapshot → 按 `Last-Event-ID` 从 PG 补发 → 实时推送。
- 客户端 `useEventSource` 支持 `lastEventId`、重连退避、按 seq 去重。
- 提交详情页改为 SSE + fallback 轮询。
- 保留策略：默认 7 天清理任务。

**Acceptance:**
- 断线重连不丢事件。
- 先订阅后变终态、先变终态后订阅均不丢。
- 多频道连接用全局游标正确补发。
- 所有频道事件都能从 `sse_events` 查到。

### Milestone 2.4：可重放审计日志

**Files:**
- Modify: `noj-llm-gateway/src/**`
- Create: `noj-llm-gateway/src/audit-log.ts`
- Modify: `noj-core/src/services/submissions/**`（LLM 题结果记录）

**Deliverables:**
- LLM 网关记录完整请求/响应/工具调用。
- 模型可见内容可从日志重建。

**Acceptance:**
- 审计日志支持按 submission/session 重放。

### Milestone 2.5：配置分层

**Files:**
- Modify: `scripts/dev/devtool.sh`
- Modify: `.env.prod.example`、`env.e2e.template`
- Create: `scripts/check-env.ts`（强化）

**Deliverables:**
- dev/e2e/prod 配置抽象为 profile + overlay。
- 环境变量校验统一。

**Acceptance:**
- 三套环境配置不漂移；缺变量启动失败。

### Milestone 2.6：生成式 Catalog

**Files:**
- Create: `scripts/gen-event-catalog.ts`
- Create: `scripts/gen-route-catalog.ts`
- Modify: `.github/workflows/ci.yml`

**Deliverables:**
- 从源码生成 SSE 事件表、API 路由表。
- CI 校验生成文件与源码一致。

**Acceptance:**
- 手改生成文件会使 CI 失败。

---

## Phase 3：固化与持续改进

**目标：** 让质量门禁成为团队日常。

### Milestone 3.1：PR 检查清单

**Files:**
- Modify: `.github/pull_request_template.md`
- Modify: `AGENTS.md`

**Deliverables:**
- PR template 包含：文档同步、注释契约、测试覆盖、决策记录、GPG/Conventional Commits。

**Acceptance:**
- 新 PR 默认包含完整检查项。

### Milestone 3.2：月度质量审计

**Files:**
- Create: `scripts/run-quality-audit.ts`
- Modify: `.github/workflows/ci.yml`（或独立 schedule workflow）

**Deliverables:**
- 每月扫描 docs 漂移、注释覆盖率、覆盖率趋势、SSE 事件表增长。

**Acceptance:**
- 审计报告自动生成并附到 issue。

### Milestone 3.3：Postmortem 制度

**Files:**
- Create: `docs/postmortem/README.md`
- Modify: `AGENTS.md`

**Deliverables:**
- 严重事故模板：事实、根因、防复发。

**Acceptance:**
- 严重事故 PR 必须附带 postmortem。

### Milestone 3.4：门禁迭代

**Files:**
- Modify: `scripts/verify-export-jsdoc.ts`
- Modify: `scripts/coverage-report.ts`
- Modify: `scripts/verify-md-links.ts`

**Deliverables:**
- 根据误报率调整规则；保留人工豁免通道。

**Acceptance:**
- 门禁误报率低于可接受阈值，且未被大面积豁免绕过。

---

## 依赖关系

```text
Phase 0.1 决策记录
  → Phase 0.2 JSDoc 门禁（规则依赖决策记录约定）
  → Phase 0.3 文档链接门禁
  → Phase 0.4/0.5/0.6 文档治理
  → Phase 0.7 本地快检
    → Phase 1.1 集中 Gate Runner（依赖 0.2/0.3/0.7）
      → Phase 1.2 覆盖率门禁
      → Phase 1.3 真实入口 Smoke
      → Phase 1.4/1.5 LLM 回放与 with-key E2E
      → Phase 1.6 防御模式测试
      → Phase 1.7 类型安全
        → Phase 2.1 Capability Seam
        → Phase 2.2 事件域分离
          → Phase 2.3 SSE 事件日志（依赖 2.2 与 1.7）
          → Phase 2.4 可重放审计日志
        → Phase 2.5 配置分层
        → Phase 2.6 生成式 Catalog
          → Phase 3 固化与持续改进
```

---

## 里程碑级验收汇总

| 阶段 | 退出条件 |
|---|---|
| Phase 0 | 文档/注释/决策记录有 CI 门禁；根文档瘦身；已知漂移清理 |
| Phase 1 | 集中 gate runner、覆盖率门禁、真实入口 smoke、LLM 回放、防御模式测试、类型安全 |
| Phase 2 | 能力 seam、事件域分离、SSE 事件日志、审计日志、配置分层、生成式 catalog |
| Phase 3 | PR 清单、月度审计、postmortem、门禁迭代机制 |

---

## 执行说明

本总计划是里程碑级。开始执行某个里程碑时，先用 writing-plans 生成该里程碑的详细任务级计划（含具体文件、测试代码、提交步骤），再按 `subagent-driven-development` 或 `executing-plans` 执行。
