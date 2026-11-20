# Neuro OJ (NOJ) — AI 编码助手项目知识库

> 面向 AI 编码助手，**只放「规则 + 链接」**：详见各模块文档与
> `dev-docs/engineering/`，代码/命令即可得知的细节不重复。

Neuro OJ 是面向 **AI 领域认证与竞赛** 的在线评测平台（IOAI / NOAI / LMCC 等），
支持客观题、代码题、LLM 工程题与产物提交（类 Kaggle）评测；与 CCF、LMCC、IOAI 及
NOAI 无官方关系，为独立社区项目。

**导航**：[项目架构](#1-项目架构) · [AI 辅助开发](#2-ai-辅助开发) ·
[基础设施与启动](#3-基础设施与启动) · [数据库](#4-数据库) ·
[版本控制](#5-版本控制与提交规范) · [必须遵守的要求](#6-ai-必须遵守的要求) ·
[贡献流程](#7-贡献流程) · [安全与测试](#8-安全与测试) · [CI/CD](#9-cicd) ·
[参考文档](#10-参考文档) · [品牌](#11-品牌与设计系统)

## 1. 项目架构

各模块通过 RESTful API、Redis MQ 和内部 HTTP 服务协作：

| 模块               | 运行时                             | 职责                                                                         |
| ------------------ | ---------------------------------- | ---------------------------------------------------------------------------- |
| noj-core           | Deno 2 + Hono                      | RESTful API、JWT + 固定角色授权、业务 CRUD、Redis MQ Producer/Consumer、审计 |
| noj-ui             | Nuxt 4 + Vue 3                     | Web 前端、Nitro 代理注入 JWT Cookie                                          |
| noj-judge          | Rust + Tokio                       | Docker 沙箱评测、双容器 Evaluator + Solution                                 |
| noj-llm-gateway    | Deno + Hono                        | LLM 调用可信代理、Provider Key 加密、eval_token、限流/额度/审计              |
| noj-lmcc-extension | VS Code Extension API + TypeScript | LMCC IDE 登录、题目选择、Python 代码提交与结果反馈                           |
| noj-cli            | Deno 2（`deno compile` 单二进制）  | 生产安装、启停、升级、备份/恢复/演练、配置校验                               |

基础设施：PostgreSQL 16、Redis 7、MinIO/S3。技术栈与依赖见各模块 `deno.json` /
`Cargo.toml`；架构总览见
[noj-docs/docs/system/architecture.md](noj-docs/docs/system/architecture.md)。

顶层目录：`noj-core/` `noj-ui/` `noj-judge/` `noj-llm-gateway/`
`noj-lmcc-extension/` `noj-cli/` `noj-tests/`（E2E）`noj-docs/`（文档站）
`dev-docs/`（工程规范/设计）`openspec/`（变更提案）`scripts/`（构建/门禁）
`deploy/` `fixtures/`。`noj-problems/` 为独立私有仓库（主仓库 gitignore）。

### 1.1 架构方向（重构中）

noj-core 正从 `modules/`（+ `application/` 编排层与跨模块合同层）迁移到
**`shared/` + `features/<name>/`** 两层；期间新旧结构并存，旧模块「改到即迁」。
方案与分阶段计划以
[openspec/changes/refactor-core-feature-slices/](openspec/changes/refactor-core-feature-slices/)
（`proposal.md`、`design.md`）为准；新增功能的结构与依赖规则依提案，不要自行发明。

**新功能照样例写**：复制
[`noj-core/src/features/trainings/`](noj-core/src/features/trainings/)
的组织方式（`index.ts` 唯一出口 + `defineFeature`），在
`noj-core/src/features.ts` 加一行即完成路由/任务/worker
装配；`scripts/check-feature-boundaries.ts` 强制依赖规则。

## 2. AI 辅助开发

### 2.1 子模块文档优先加载

| 路径                               | 优先加载                                   |
| ---------------------------------- | ------------------------------------------ |
| `noj-core/` `noj-ui/` `noj-judge/` | 各自 `AGENTS.md`（`CLAUDE.md` 为软链接）   |
| `noj-llm-gateway/`                 | `noj-llm-gateway/CLAUDE.md`                |
| `noj-cli/`                         | `noj-cli/README.md`                        |
| `noj-tests/`                       | `noj-tests/E2E_TESTING.md`                 |
| `noj-lmcc-extension/`              | 无模块文档，以本文档与 `package.json` 为准 |

进模块目录前先读对应文档；涉及对应领域时加载环境提供的技能。

## 3. 基础设施与启动

开发默认凭据：PostgreSQL `localhost:5432` `noj / noj / noj`；Redis
`localhost:6379` 无认证； MinIO `9000`/`9001` `minioadmin / minioadmin`。

**源码开发**：首次：`docker compose up -d`（基础设施，另含 llm-gateway 容器
:8001）→ `cd noj-core && deno task dev-setup`（幂等：迁移 + 系统数据 +
管理员引导 + 题目包） → 各模块 `deno task dev`（`noj-judge` 为
`cargo run`）。从源码运行 `noj-llm-gateway` 前需
`docker compose stop llm-gateway`，否则端口冲突。 noj-core 启动顺序（env 校验 →
迁移 → 后台任务 → HTTP）以 [`noj-core/src/main.ts`](noj-core/src/main.ts) 的
`main()` 为准。

**生产运维**统一使用 `noj-cli`（单一配置真相源 `.env.prod`）：安装与
`check|status|start|stop|restart|logs|update|backup|verify|config` 等命令见
[noj-cli/README.md](noj-cli/README.md) 与
[noj-docs/docs/operators/production-deploy.md](noj-docs/docs/operators/production-deploy.md)。

## 4. 数据库

完整 Schema、迁移约定与表关系见 [`noj-core/AGENTS.md`](noj-core/AGENTS.md)。

- 迁移文件：`noj-core/drizzle/*.sql`，由 `deno task db:generate` 生成
- **禁止手动修改 `_journal.json`**；迁移严格按编号，只能追加

## 5. 版本控制与提交规范

### 5.1 分支与集成分支

- 当前实际开发集成分支为 **`rc/v0.11`**（领先 `main`）。**禁止直接推送 `main` 与
  rc 分支**：所有变更（功能、缺陷修复、文档）一律从当前集成分支派生主题分支，
  通过 Pull Request 合入当前集成分支（流程见 §7.1）。
- 合入前必须完成相关检查与验收，并等待 CI 通过。
- 集成分支必须始终保持可部署状态；发布从已验证提交或版本标签构建。
- AI 工具配置、编辑器配置、临时日志、备份文件等本地产物不得提交。

本地用 jj：`jj describe` 设提交信息、`jj new` 新提交、`jj squash` 压回、
`jj git push` 推送、`jj undo` 回退。

### 5.2 提交信息

- 格式：`<type>(<scope>): <中文描述>`
- type：`feat` `fix` `docs` `style` `refactor` `perf` `test` `chore` `ci`
  `build`
- scope：模块 `core` `ui` `judge` `gateway` `cli` `lmcc` `docs`（noj-docs）
  `tests`（noj-tests）；横切 `root`（根目录与 `scripts/`、`dev-docs/` 等）`ci`
  `deps`（依赖升级）。多模块用英文逗号分隔、不加空格：`feat(core,ui): ...`

### 5.3 语言与签名

中文：提交描述、注释、文档、PR/Issue；英文：代码标识符。 **所有提交必须 GPG
签名**，AI 修改代码前必须确认签名可用（§7.2）。

## 6. AI 必须遵守的要求

### 6.1 不可逾越的红线

1. 禁止直接推送 `main` 与 rc 集成分支；一律通过 PR 合入当前集成分支，合入前完成
   相关检查和验收，确保集成分支保持可部署状态
2. 禁止未签名提交
3. 禁止修改 `_journal.json`
4. 禁止手动修改 `deno.lock` / `Cargo.lock`
5. 禁止在 `.env` 中硬编码真实凭据
6. 禁止直连生产库改 schema
7. 优先使用 `scripts/` 下的开发脚本

### 6.2 编码规范

- TypeScript/Deno：`deno fmt` + `deno lint`；Rust：`cargo fmt` +
  `cargo clippy`； Vue：`deno lint` + `deno fmt`（均 CI 强制）
- 中文注释 + 英文标识符
- Deno 错误用 `AppError` 继承体系；Rust 用 `anyhow::Result`
- 日志生产环境自动脱敏，不得直接输出敏感字段。
- **多副本约束**：业务事实、额度、限流及需跨副本一致的状态一律走 Redis/DB；
  只读、可容忍短暂不一致的数据可放有界且带 TTL 的进程内缓存，新增缓存必须在
  [`dev-docs/engineering/domain-boundaries.md`](dev-docs/engineering/domain-boundaries.md#多副本约束2026-09-12-架构评审-26)
  登记 TTL 与多副本后果；其余进程内可变状态必须登记为「单副本专用」。
  **配置失效必须「重新加载」而非仅 `cache.delete()`**（`getSetting()`
  缓存未命中不回查 DB，只删缓存会读到 env/default 而非真实新值）。
- **迁移安全**：禁止 `ALTER TABLE ... ADD COLUMN ... NOT NULL` 不带 `DEFAULT`
  （存量库升级必失败，空库无法发现）；必须三步式：加可空列 → 回填 →
  `SET NOT NULL`，由 `scripts/check-migration-safety.ts` 强制。

### 6.3 改动检查清单

- [ ] `deno fmt` / `cargo fmt` 已运行，`deno lint` / `cargo clippy` 无警告
- [ ] 新功能/修复有对应测试，且通过 `deno task` 运行
- [ ] 新表/字段已通过 `deno task db:generate` 生成迁移
- [ ] 新环境变量已登记注册表并加入对应模块 `.env.example`
- [ ] 中文提交描述符合 Conventional Commits，GPG 签名可用
- [ ] 非平凡变更包含 Agent Note（`.agents/notes/implemented/`）

### 6.4 测试执行要求

- 优先 `deno task test:parallel`；零依赖用 `deno task test`；快速反馈用
  `deno task test:smoke`
- **按 Domain 测试必须使用规定命令，禁止手拼 `deno test`**：
  - noj-core 单元/集成：`cd noj-core && deno task test:domain <domain>`
  - noj-core 共享测试：`cd noj-core && bash scripts/test-shared.sh`
  - noj-tests E2E：`cd noj-tests && deno task test:domain <domain>`
  - 跨域 E2E：`cd noj-tests && deno task test:domain cross-domain`
- 这些命令统一处理迁移/种子、环境变量与测试路径；手拼 `deno test` 会丢失必要
  配置，CI 与本地必须使用同一套命令。

### 6.5 搜索工具要求

- 搜索代码/文件内容必须使用 `rg`（ripgrep），不要使用 `grep`；仅当环境中不存在
  `rg` 时才允许回退。

## 7. 贡献流程

### 7.1 PR 工作流（所有变更）

当前集成分支以 `rc/v0.11` 为例；集成分支切换时同步替换。

```bash
jj git fetch
jj new rc/v0.11@origin
jj describe
jj git push --named <branch-name>=@      # 首次推送时创建同名 bookmark
gh pr create --draft --base rc/v0.11 --head <branch-name>
# 迭代：在新提交上修改后压回，再推送（jj 自带 force-with-lease 式安全检查，无需 --force）
jj new
jj squash
jj git push -b <branch-name>
```

### 7.2 Agent GPG 检查

`gpg --list-secret-keys --keyid-format LONG`、`git config --global user.signingkey`、
`git config --global commit.gpgsign`、`jj config get signing.key`。

### 7.3 Agent Notes（决策记录）

非平凡变更必须在 `.agents/notes/implemented/<分类>/yyyy-mm-dd-topic-title.md`
新增或更新记录（分类：`feature` / `bug-fix` / `simplification` / `architecture`
/ `process` / `testing`）。格式：`# Agent Note: <标题>`、`Status: implemented`
及 `## Problem` / `## Decision` / `## Alternatives considered` /
`## Consequences` 四节；校验
`deno run -A scripts/verify-agent-note-format.ts`，约定见
`.agents/notes/README.md`。

## 8. 安全与测试

安全模型见 [security.md](noj-docs/docs/system/security.md) 与
[defensive-patterns.md](dev-docs/engineering/defensive-patterns.md)。关键规则：

- JWT HS256，HTTP-only Cookie，24h 过期
- bcrypt cost 12，最小 8 位含大小写字母与数字
- 容器：`cap_drop ALL`、`no-new-privileges`、`network_mode none`、`ipc_mode none`、`pids_limit 256`
- ZIP：拒绝路径穿越，≤1000 条目 / 64MiB 单文件 / 512MiB 总解压
- 日志：业务 ID 与 score 保留，code/token/secret/password 等及 DB 密码脱敏；
  审计日志保留 90 天（可配置）

测试分层见 [testing.md](dev-docs/engineering/testing.md)：noj-core
`deno task test` / `test:parallel` / `test:smoke`；noj-ui
`deno task test`；noj-judge `cargo nextest run --all-targets`（Docker E2E 用
`NOJ_RUN_E2E=1`）；noj-tests `deno task test`。Deno 测试必须通过 `deno task`
运行。

## 9. CI/CD

- `ci.yml`：静态检查、测试、构建（按模块路径过滤）；`e2e.yml`：跨模块全链路
  E2E + judge 沙箱；`release.yml`：预发布 Release 构建镜像、`noj-cli`
  二进制与部署文件 （附 `.sha256`）；`lint-workflows.yml`：actionlint
- CI 同时检查文档链接（`scripts/verify-md-links.ts`）与 Agent Note 格式
  （`scripts/verify-agent-note-format.ts`）

故障排查：`noj-cli status --dir <安装目录>` 与
[常见问题](https://docs.noj.xyber-nova.space/intro/faq.html)。

## 10. 参考文档

| 文档               | 路径                                                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 模块约定           | [`noj-core/AGENTS.md`](./noj-core/AGENTS.md)、[`noj-ui/AGENTS.md`](./noj-ui/AGENTS.md)、[`noj-judge/AGENTS.md`](./noj-judge/AGENTS.md) |
| noj-cli / 生产部署 | [`noj-cli/README.md`](./noj-cli/README.md)、[production-deploy.md](./noj-docs/docs/operators/production-deploy.md)                     |
| E2E 测试指南       | [`noj-tests/E2E_TESTING.md`](./noj-tests/E2E_TESTING.md)                                                                               |
| 工程规范           | [`dev-docs/engineering/README.md`](./dev-docs/engineering/README.md)                                                                   |
| core 重构提案      | [`openspec/changes/refactor-core-feature-slices/`](./openspec/changes/refactor-core-feature-slices/)                                   |
| 品牌设计 Token     | [`dev-docs/design/noj-design-tokens.md`](./dev-docs/design/noj-design-tokens.md)                                                       |

## 11. 品牌与设计系统

所有前端与文档站颜色、圆角必须遵循 `dev-docs/design/noj-design-tokens.md`。

- 品牌天青蓝：`#0284c7`（亮色 Sky 600）/ `#38bdf8`（暗色 Sky 400）——高亮链接、
  关键按钮、激活项与品牌交互
- 深邃科技海军蓝：`#0b0f19`（暗色底）/ `#131b2e`（暗色面板）/ `#0f172a`（Slate
  900 正文）——品牌身份、暗色沉浸 Hero、终端
- 评测信号绿：`#059669`（亮色）/ `#00e07a`（暗色）——评测状态、提交通过、运行就绪
- 修改品牌 token 时必须同步更新 `noj-ui/app.vue`、`noj-ui/assets/css/main.css`、
  `noj-docs` 主题与本文档；
- 圆角 2–6px（默认 4px），数值文本用 `tabular-nums`

_本文档为顶层 AI 入口；各模块详细约定请参考对应子目录 `AGENTS.md` /
`CLAUDE.md`。_
