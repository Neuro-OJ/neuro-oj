# Neuro OJ (NOJ) — AI 编码助手项目知识库

> 本文档面向 AI 编码助手（Claude Code、OpenCode 等）撰写，记录项目架构、规范、AI
> 必须遵守的要求与开发约定。**本文档只放“规则 + 链接”，详细内容见各模块文档与 `docs/engineering/`。**

Neuro OJ 是一个面向 **AI 领域认证与竞赛** 的在线评测（Online Judge）平台，覆盖 **IOAI / NOAI / LMCC** 等场景，支持客观题、代码题、LLM 工程题与产物提交（类 Kaggle）评测。

> **注意：** Neuro OJ 与 CCF、LMCC、IOAI 及 NOAI 无任何官方关系，为独立社区项目。

---

## 目录

1. [项目架构](#1-项目架构)
2. [AI 辅助开发](#2-ai-辅助开发)
3. [目录结构](#3-目录结构)
4. [技术栈](#4-技术栈)
5. [基础设施与启动](#5-基础设施与启动)
6. [数据库](#6-数据库)
7. [版本控制与提交规范](#7-版本控制与提交规范)
8. [AI 必须遵守的要求](#8-ai-必须遵守的要求)
9. [贡献流程](#9-贡献流程)
10. [OpenSpec 开发工作流](#10-openspec-开发工作流)
11. [安全模型](#11-安全模型)
12. [测试体系](#12-测试体系)
13. [CI/CD](#13-cicd)
14. [故障排查](#14-故障排查)
15. [参考文档](#15-参考文档)

---

## 1. 项目架构

NOJ 分为多个模块，通过 RESTful API、Redis MQ 和内部 HTTP 服务协作：

```text
+----------+   RESTful API   +----------+   Redis MQ    +--------------+
|  noj-ui  | <-------------> | noj-core | --Producer--> |  noj-judge   |
|  Nuxt 4  |                 |Deno+Hono | <--Consumer--|  Rust+Docker |
+----------+                 +----------+               +--------------+
                                   |
                              +----+----+
                              |  Redis   |
                              +---------+
```

| 模块 | 运行时 | 职责 |
|---|---|---|
| noj-core | Deno 2 + Hono | RESTful API、JWT + RBAC、业务 CRUD、Redis MQ Producer/Consumer、审计 |
| noj-ui | Nuxt 4 + Vue 3 | Web 前端、Nitro 代理注入 JWT Cookie |
| noj-judge | Rust + Tokio | Docker 沙箱评测、双容器 Evaluator + Solution |
| noj-llm-gateway | Deno + Hono | LLM 调用可信代理、Provider Key 加密、eval_token、限流/额度/审计 |

详细架构见 [noj-docs/docs/system/architecture.md](noj-docs/docs/system/architecture.md) 和各模块文档。

---

## 2. AI 辅助开发

### 2.1 AI 技能

AI 技能由开发环境按需提供，仓库不再提交 Claude Code、OpenCode、Codex 等工具的个人配置或重复技能副本。适用领域如下：

| 技能 | 适用场景 |
|---|---|
| `deno-expert` / `hono` | Deno / Hono 开发 |
| `nuxt` / `vue` | 前端开发 |
| `redis-core` | Redis MQ / 缓存 |
| `docker-expert` | judge 沙箱、docker-compose |
| `supabase-postgres-best-practices` | PostgreSQL + Drizzle |
| `review` | 代码评审 |
| `openspec-*` | OpenSpec 规范驱动开发 |

### 2.2 AI 命令

| 命令 | 作用 |
|---|---|
| `/opsx:explore` | 探索现有规范 |
| `/opsx:propose` | 起草变更提案 |
| `/opsx:apply` | 实施已批准变更 |
| `/opsx:archive` | 归档已完成变更 |
| `/opsx:sync` | 同步 spec 增量 |

### 2.3 子模块文档优先加载

| 当前路径 | 优先加载 |
|---|---|
| 仓库根 | 本文档 |
| `noj-core/` | `noj-core/CLAUDE.md` |
| `noj-ui/` | `noj-ui/CLAUDE.md` |
| `noj-judge/` | `noj-judge/CLAUDE.md` |
| `noj-llm-gateway/` | `noj-llm-gateway/CLAUDE.md` |

---

## 3. 目录结构

```text
neuro-oj/
├── noj-core/       # Deno + Hono 后端（CLAUDE.md 有完整目录）
├── noj-ui/         # Nuxt 4 前端（CLAUDE.md 有完整目录）
├── noj-judge/      # Rust 评测 Worker（CLAUDE.md 有完整目录）
├── noj-llm-gateway/# LLM 网关（CLAUDE.md 有完整目录）
├── noj-tests/      # 跨模块 E2E 测试
├── noj-docs/       # 用户/出题人/运营者文档站（VitePress）
├── openspec/       # OpenSpec 行为规范与变更
├── docs/           # 设计文档、实施计划、工程规范、审计
├── scripts/        # 构建与运维脚本（dev/e2e 等）
├── .agents/        # 工程决策记录（仅开发辅助）
├── .github/        # CI/CD 与 PR 模板
├── AGENTS.md       # 本文档
└── README.md       # 用户面向 README
```

详细目录见各模块 `CLAUDE.md`。

---

## 4. 技术栈

| 模块 | 关键依赖 |
|---|---|
| noj-core | Deno 2、Hono、Drizzle ORM、postgres.js、ioredis、jose、bcryptjs |
| noj-ui | Nuxt 4、Vue 3、Nuxt UI、Tailwind CSS、Monaco Editor |
| noj-judge | Rust、Tokio、bollard、redis-rs、reqwest、zip |
| noj-llm-gateway | Deno 2、Hono、ioredis、postgres.js |
| 基础设施 | PostgreSQL 16、Redis 7、MinIO/S3 |

完整依赖清单见各模块 `CLAUDE.md` / `deno.json` / `Cargo.toml`。

---

## 5. 基础设施与启动

### 5.1 默认凭据（仅开发）

| 服务 | 端口 | 凭据 |
|---|---|---|
| PostgreSQL | 5432 | `noj / noj / noj` |
| Redis | 6379 | 无认证 |
| MinIO（e2e） | 9000/9001 | `minioadmin / minioadmin` |

### 5.2 一键脚本

```bash
bash scripts/dev/devtool.sh install-deps --check-only
bash scripts/dev/devtool.sh init-env
bash scripts/dev/devtool.sh start          # infra → core → ui → judge
bash scripts/dev/devtool.sh status
bash scripts/dev/devtool.sh stop
```

### 5.3 手动启动

```bash
docker compose up -d
cd noj-core && deno task dev
cd noj-ui && deno task dev
cd noj-judge && cargo run
cd noj-llm-gateway && deno task dev   # 可选
```

### 5.4 noj-core 启动顺序

1. JWT_SECRET 强度校验（≥32 字符，失败退出）
2. 数据库迁移（失败致命）
3. 确保 root 系统用户
4. 连接 Redis（失败 → degraded）
5. 启动评测结果消费者
6. 启动 HTTP

---

## 6. 数据库

完整 Schema、迁移约定与表关系见 [`noj-core/CLAUDE.md`](noj-core/CLAUDE.md)。

- 迁移文件：`noj-core/drizzle/*.sql`
- 由 `deno task db:generate` 自动生成
- **禁止手动修改 `_journal.json`**
- 迁移顺序严格按编号，只能追加

---

## 7. 版本控制与提交规范

### 7.1 分支与发布纪律

- 日常开发、功能实现、缺陷修复和实验性变更请提交至 `dev` 分支，或从 `dev` 派生功能分支后通过 PR 合入 `dev`。
- `main` 分支只接受经过评审、检查和验收的变更；禁止直接在 `main` 上进行日常开发或提交本地调试产物。
- `main` 分支必须始终保持可部署状态；发布应从已验证的 `main` 提交或版本标签构建。
- AI 工具配置、编辑器配置、临时日志、备份文件和其他本地开发产物不得提交到 `main`。

### 7.2 Jujutsu (jj)

- 本地使用 jj，推送使用 `jj git push`
- `jj describe` 设提交信息，`jj new` 创建新提交，`jj undo` 回退

### 7.2 提交信息

- 格式：`<type>(<scope>): <中文描述>`
- type：`feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `chore` / `ci` / `build`
- scope：`core` / `ui` / `judge` / `root`

### 7.3 项目语言

主要语言为中文：提交描述、注释、文档、PR/Issue 必须中文；代码标识符使用英文。

### 7.4 GPG 签名（强制）

所有提交必须 GPG 签名。AI 修改代码前必须确认签名可用。

### 7.5 OpenSpec 归档目录命名

- 格式：`YYYY-MM-DD-<kebab-case-name>`
- 日期为归档当日（UTC+8）
- name 与原变更名完全一致

---

## 8. AI 必须遵守的要求

### 8.1 不可逾越的红线

1. 禁止直接推送到 `main`
2. 禁止未签名提交
3. 禁止跳过 OpenSpec（功能性变更必须先提案）
4. 禁止修改 `_journal.json`
5. 禁止手动修改 `deno.lock` / `Cargo.lock`
6. 禁止在 `.env` 中硬编码真实凭据
7. 禁止直连生产库改 schema
8. 优先使用 `scripts/` 下的开发脚本

### 8.2 编码规范

- TypeScript/Deno：`deno fmt` + `deno lint`（CI 强制）
- Rust：`cargo fmt` + `cargo clippy`（CI 强制）
- Vue：`deno lint` + `deno fmt`
- 中文注释 + 英文标识符
- Deno 错误用 `AppError` 继承体系；Rust 用 `anyhow::Result`
- 日志生产环境自动脱敏，不得直接输出敏感字段

### 8.3 修改前必读

进入模块目录前先读对应的模块开发文档；涉及对应领域时加载对应技能。

### 8.4 改动检查清单

- [ ] `deno fmt` / `cargo fmt` 已运行
- [ ] `deno lint` / `cargo clippy` 无警告
- [ ] 新功能/修复有对应测试
- [ ] 新表/字段已通过 `deno task db:generate` 生成迁移
- [ ] 新环境变量已加入 `.env.example` + `scripts/dev/env.example`
- [ ] 中文提交描述符合 Conventional Commits
- [ ] GPG 签名可用
- [ ] 若是功能变更，OpenSpec 变更已 `/opsx:propose` 起草
- [ ] 非平凡变更包含 Agent Note（`.agents/notes/implemented/`）
- [ ] 优先使用 `scripts/` 下的开发工具脚本
- [ ] 测试通过 `deno task` 运行

### 8.5 测试执行要求

- 优先 `deno task test:parallel`
- 零依赖用 `deno task test`
- 快速反馈用 `deno task test:smoke`
- 不要直接手拼 `deno test`（会丢失必要环境配置）

---

## 9. 贡献流程

### 9.1 PR 工作流

```bash
jj new main
jj describe
jj git push -b <branch-name>
gh pr create --draft
# 迭代
jj new
jj squash
jj git push -b <branch-name> --force
```

### 9.2 Agent GPG 检查

```bash
gpg --list-secret-keys --keyid-format LONG
git config --global user.signingkey
git config --global commit.gpgsign
jj config get signing.key
```

### 9.3 Agent Notes（决策记录）

非平凡变更必须新增或更新 `.agents/notes/implemented/` 下对应记录。

- 分类：`feature` / `bug-fix` / `simplification` / `architecture` / `process` / `testing`
- 路径：`implemented/<分类>/yyyy-mm-dd-topic-title.md`
- 格式：`# Agent Note: <标题>` + `Status: implemented` + `## Problem` / `## Decision` / `## Alternatives considered` / `## Consequences`
- 校验：`deno run -A scripts/verify-agent-note-format.ts`
- 详细约定见 `.agents/notes/README.md`

---

## 10. OpenSpec 开发工作流

任何功能性变更必须按顺序：

1. `/opsx:explore` — 探索现有规范
2. `/opsx:propose` — 起草变更提案
3. 评审 → 实现
4. `/opsx:apply` — 实施
5. 测试通过后 `/opsx:archive` — 归档

目录：`openspec/specs/`（主规范）、`openspec/changes/`（活跃/归档变更）。

---

## 11. 安全模型

详细安全模型见 [noj-docs/docs/system/security.md](noj-docs/docs/system/security.md) 与 [docs/engineering/defensive-patterns.md](docs/engineering/defensive-patterns.md)。

关键规则：

- JWT HS256，HTTP-only Cookie，24h 过期
- bcrypt cost 12，最小 8 位含大小写字母与数字
- 容器：`cap_drop ALL`、`no-new-privileges`、`network_mode none`、`ipc_mode none`、`pids_limit 256`
- ZIP：拒绝路径穿越，≤1000 条目 / 64MiB 单文件 / 512MiB 总解压
- 日志：UUID 截断、score 隐藏、DB 密码脱敏
- 审计日志保留 90 天（可配置）

---

## 12. 测试体系

详细命令与分层见 [docs/engineering/testing.md](docs/engineering/testing.md)。

- noj-core：`deno task test` / `test:parallel` / `test:smoke`
- noj-ui：`deno task test`
- noj-judge：`cargo nextest run --all-targets`；Docker E2E 用 `NOJ_RUN_E2E=1`
- noj-tests：`deno task test`
- 必须通过 `deno task` 运行 Deno 测试

---

## 13. CI/CD

- `.github/workflows/ci.yml`：PR/推送静态检查、测试、构建；按模块路径过滤
- `.github/workflows/e2e.yml`：跨模块全链路 E2E + judge 沙箱
- 文档链接、Agent Note 格式、导出 JSDoc 覆盖率均在 CI 检查

---

## 14. 故障排查

常见问题与处理见 [README.md](README.md#故障排查) 和 `scripts/dev/devtool.sh status --json`。

---

## 15. 参考文档

| 文档 | 路径 |
|---|---|
| 用户 README | [`README.md`](./README.md) |
| noj-core 详细文档 | [`noj-core/CLAUDE.md`](./noj-core/CLAUDE.md) |
| noj-ui 详细文档 | [`noj-ui/CLAUDE.md`](./noj-ui/CLAUDE.md) |
| noj-judge 详细文档 | [`noj-judge/CLAUDE.md`](./noj-judge/CLAUDE.md) |
| noj-llm-gateway 详细文档 | [`noj-llm-gateway/CLAUDE.md`](./noj-llm-gateway/CLAUDE.md) |
| E2E 测试指南 | [`noj-tests/E2E_TESTING.md`](./noj-tests/E2E_TESTING.md) |
| 开发工具 devtool.sh | [`scripts/dev/devtool.sh`](./scripts/dev/devtool.sh) |
| 工程规范 | [`docs/engineering/README.md`](./docs/engineering/README.md) |
| OpenSpec 主规范 | [`openspec/specs/`](./openspec/specs/) |
| 系统架构 | [`noj-docs/docs/system/architecture.md`](./noj-docs/docs/system/architecture.md) |
| 安全模型 | [`noj-docs/docs/system/security.md`](./noj-docs/docs/system/security.md) |
| Superpowers 设计稿 | [`docs/superpowers/specs/`](./docs/superpowers/specs/) |
| Superpowers 实施计划 | [`docs/superpowers/plans/`](./docs/superpowers/plans/) |

---

_本文档为顶层 AI 入口。各模块详细约定、API 端点、Schema 字段、组件层级请参考对应子目录 `CLAUDE.md`。_
