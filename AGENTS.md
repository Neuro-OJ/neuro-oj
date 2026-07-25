# Neuro OJ (NOJ) — AI 编码助手项目知识库

> 本文档面向 AI 编码助手（Claude Code、OpenCode 等）撰写，记录项目架构、规范、AI 必须遵守的要求与开发约定。

Neuro OJ 是一个面向 LMCC（CCF 大语言模型能力认证）的在线评测（Online Judge）系统。

> **注意：** Neuro OJ 与 CCF 及 LMCC 无任何官方关系，为独立社区项目。

---

## 目录

1. [项目架构](#1-项目架构)
2. [AI 工具集成](#2-ai-工具集成)
3. [目录结构](#3-目录结构)
4. [技术栈与依赖](#4-技术栈与依赖)
5. [基础设施与启动](#5-基础设施与启动)
6. [数据库 Schema](#6-数据库-schema)
7. [版本控制与提交规范](#7-版本控制与提交规范)
8. [AI 必须遵守的要求](#8-ai-必须遵守的要求)
9. [贡献流程](#9-贡献流程)
10. [OpenSpec 开发工作流](#10-openspec-开发工作流)
11. [安全模型](#11-安全模型)
12. [测试体系](#12-测试体系)
13. [CI/CD](#13-cicd)
14. [故障排查速查](#14-故障排查速查)
15. [项目状态与路线图](#15-项目状态与路线图)
16. [参考文档](#16-参考文档)

---

## 1. 项目架构

NOJ 分为三个核心模块，通过 RESTful API 和 Redis 消息队列协作：

```
+----------+   RESTful API   +----------+   Redis MQ    +--------------+
|  noj-ui  | <-------------> | noj-core | --Producer--> |  noj-judge   |
|  Nuxt 4  |                 |Deno+Hono | <--Consumer--|  Rust+Docker |
+----------+                 +----------+               +--------------+
                                   |
                              +----+----+
                              |  Redis   |
                              +---------+
```

### 1.1 模块职责

| 模块 | 运行时 | 职责 |
|------|--------|------|
| **noj-core** | Deno 2 + Hono | RESTful API、JWT 鉴权、用户/题目/提交/榜单 CRUD、Redis MQ Producer 与 Consumer、审计日志 |
| **noj-ui** | Nuxt 4 + Vue 3 | Web 前端、Nitro 反向代理注入 JWT Cookie、SSR + SPA 混合 |
| **noj-judge** | Rust 2021 + Tokio | Docker 沙箱评测、Redis MQ Consumer、容器池（懒回补 + 健康检查）、双容器架构（dual container） |
| **基础设施** | — | PostgreSQL 16（持久化） + Redis 7（MQ + 缓存） |

### 1.2 消息流（Producer-Consumer）

1. 用户通过 noj-ui 提交代码
2. noj-core 接收请求，将评测任务 `LPUSH` 到 `noj:judge:queue`
3. noj-judge `BRPOP` 拉取任务
4. noj-judge 在 Docker 容器中执行评测（资源隔离、网络关闭）
5. 结果 `LPUSH` 到 `noj:judge:results`
6. noj-core `BRPOP` 消费结果并持久化到 PostgreSQL

支持多个 noj-judge 实例水平扩展。

### 1.3 JudgeTask 消息结构

```json
{
  "submission_id": "uuid",
  "problem_id": "1001",
  "judge_image": "noj-judge-python",
  "judge_command": "python3 /tmp/evaluate.py",
  "download_url": "noj-download://base64/?content=UEsDBBQAAAAIA...&checksum_sha256=abc123",
  "language": "python3",
  "code": "...",
  "file_name": "submission.py",
  "time_limit_ms": 5000,
  "memory_limit_mb": 512
}
```

### 1.4 双层 URL 设计

| 层级 | URL 前缀 | 用途 | 字段 |
|------|---------|------|------|
| **DB 存储层** | `noj-storage://` | 标识资源在存储后端的位置 | `support_package_storage_url` |
| **Judge 交付层** | `noj-download://` | 描述 judge 如何获取支持包内容 | `JudgeTask.download_url` |

- `local` 模式：`noj-storage://local/<base64>` ↔ `noj-download://base64/?content=[base64]`
- `s3` 模式：`noj-storage://s3/<key>` ↔ `noj-download://s3?url=[presigned]`
- SHA-256 校验贯穿两个层级，支持内容寻址缓存
- 用户提交的代码**不**进支持包，由 noj-judge 运行时注入
- 支持包（zip）由 `deno task build-packages` 从 `data/problems-src/<id>/` 构建

---

## 2. AI 工具集成

本项目同时支持 **Claude Code**（`.claude/`）与 **OpenCode**（`.opencode/`），二者镜像配置。

### 2.1 AI 技能（按需通过 Skill 工具加载）

位于 `.claude/skills/` 与 `.opencode/skills/`，AI 应在相关任务中主动加载：

| 技能 | 适用场景 |
|------|---------|
| `deno-expert` | noj-core / noj-ui 的 Deno/TypeScript 开发 |
| `nuxt` / `vue` | noj-ui 前端开发 |
| `hono` | noj-core 后端路由开发 |
| `redis-core` | Redis MQ / 缓存相关 |
| `docker-expert` | noj-judge 沙箱、docker-compose |
| `supabase-postgres-best-practices` | PostgreSQL + Drizzle ORM |
| `review` | 代码评审 |
| `openspec-explore` / `openspec-propose` / `openspec-apply-change` / `openspec-archive-change` / `openspec-sync-specs` | OpenSpec 规范驱动开发全流程 |

### 2.2 AI 命令（通过 `/` 触发）

| 命令 | 作用 |
|------|------|
| `/opsx:explore` | 探索现有规范 |
| `/opsx:propose` | 起草变更提案 |
| `/opsx:apply` | 实施已批准变更 |
| `/opsx:archive` | 归档已完成变更 |
| `/opsx:sync` | 同步 spec 增量到主规范 |

### 2.3 子模块文档优先加载

工作目录决定上下文优先级：

| 当前路径 | 优先加载 |
|---------|---------|
| `/noj-core/` | `noj-core/CLAUDE.md` |
| `/noj-ui/` | `noj-ui/CLAUDE.md` |
| `/noj-judge/` | `noj-judge/CLAUDE.md` |
| 仓库根目录 | 本文档 |

子模块文档包含：API 端点、Schema 字段、组件层级、模块特有规范，进入模块目录前应先读取对应 `CLAUDE.md`。

---

## 3. 目录结构

```
neuro-oj/
├── noj-core/                  # 核心后端 Deno + Hono
│   ├── deno.json              # 项目配置 + 导入映射
│   ├── deno.lock              # 依赖锁定（提交到 git，用于 CI 缓存）
│   ├── drizzle.config.ts      # Drizzle Kit 配置
│   ├── drizzle/               # 26 个 SQL 迁移文件（自动生成，勿手改 _journal.json）
│   ├── .env.example           # 环境变量模板（不提交 .env）
│   ├── src/
│   │   ├── main.ts            # 入口（启动校验 + 初始化顺序）
│   │   ├── app.ts             # Hono 应用工厂（CORS + 路由 + 错误处理）
│   │   ├── mod.ts             # 公共导出
│   │   ├── routes/            # 11 个路由：admin / auth / categories / checkin / conversations / health / problems / queue / rankings / sse / submissions / users
│   │   ├── services/          # 业务逻辑层：auth / categories / checkin / conversations / judge-images / passwordReset / problems / queue / rankings / sse / submissions / support-package / users / system-settings / audit-log
│   │   ├── db/
│   │   │   ├── connection.ts  # 数据库连接管理（单例）
│   │   │   ├── migrate.ts     # 迁移执行器（绝对路径解析）
│   │   │   └── schema.ts      # Drizzle 表定义（17 张表）
│   │   ├── middleware/auth.ts # JWT 认证中间件
│   │   ├── mq/
│   │   │   ├── connection.ts  # Redis 连接（shared + consumer 双连接）
│   │   │   ├── consumer.ts    # 评测结果消费者
│   │   │   ├── producer.ts    # 评测任务生产者
│   │   │   ├── started_consumer.ts # 评测启动事件消费者
│   │   │   └── judge-rpc.ts   # Judge RPC 处理
│   │   ├── lib/
│   │   │   ├── errors.ts      # AppError 继承体系
│   │   │   ├── jwt.ts         # JWT 签发/验证（HS256, iss/aud 校验）
│   │   │   ├── password.ts    # bcrypt 哈希/比对（cost 12）
│   │   │   ├── request.ts     # parseJsonBody<T>() 安全 JSON 解析
│   │   │   ├── logging.ts     # 生产安全日志（UUID 截断、score 隐藏）
│   │   │   ├── event-bus.ts   # 进程内事件总线（SSE 推送）
│   │   │   ├── env-snapshot.ts# 环境变量快照（启动期记录）
│   │   │   ├── settings-registry.ts # 系统设置注册表
│   │   │   └── storage/       # 抽象存储层（StorageProvider）
│   │   │       ├── types.ts   #   接口 + URL 工具
│   │   │       ├── local.ts   #   LocalStorageProvider
│   │   │       ├── s3.ts      #   S3StorageProvider
│   │   │       ├── factory.ts #   工厂函数
│   │   │       └── mod.ts     #   公共导出
│   │   └── types/             # 跨模块类型：JudgeTask / JudgeResult / SubmissionStatus / LANGUAGE_EXT_MAP / 各类 Input/Response
│   ├── scripts/
│   │   ├── seed.ts            # 数据库种子（幂等，ON CONFLICT DO NOTHING）
│   │   ├── build-packages.ts  # 构建支持包 zip（调用系统 zip）
│   │   └── migrate.ts         # 迁移脚本（密码脱敏）
│   ├── data/
│   │   ├── problems-src/      # 题目源文件（版本控制）
│   │   │   ├── 1001/          # "星港舱门报码归一化" (easy)
│   │   │   ├── 1002/          # "传感器数据滤波" (medium, 无支持包)
│   │   │   └── 1003/          # "A+B Problem" (easy)
│   │   └── packages/          # 构建产物 (gitignored，local 模式)
│   └── tests/                 # 67 个测试文件（与 src 镜像结构）
│       ├── 00_migrate_test.ts # 迁移 + seed root 用户（最先执行）
│       ├── app.test.ts, smoke.test.ts
│       ├── services/          # 服务层测试
│       ├── routes/            # 路由层测试（jsonRequest() 辅助）
│       ├── lib/               # 工具函数测试
│       ├── middleware/, mq/, db/, types/, perf/, data/
│
├── noj-ui/                    # 前端 Nuxt 4 + Vue 3
│   ├── deno.json              # 任务 + npm 兼容（nodeModulesDir: auto）
│   ├── package.json           # @noj/ui v0.1.0
│   ├── nuxt.config.ts         # vite, nitro preset, runtimeConfig
│   ├── tailwind.config.ts     # Tailwind 主题（含 prose-neuro）
│   ├── app.vue                # 根组件 + CSS 变量
│   ├── pages/                 # 文件路由
│   ├── components/            # Navbar / FooterBar / Sidebar / MonacoEditor / ProblemEditor / MarkdownRenderer / StatusBadge / PaginationNav / ProblemFilterBar / ProblemId / ui/* / admin/*
│   ├── composables/           # useAuth / usePolling / useToast / useDialog / useProblemFilters / use-submissions
│   ├── layouts/               # default / auth / admin
│   ├── server/
│   │   ├── api/[...slug].ts   # Nitro 代理（拦截登录 + JWT 注入）
│   │   └── api/auth/logout.post.ts # 本地注销
│   ├── middleware/            # auth（5s 超时）+ admin（静默重定向）
│   ├── utils/sanitize.ts      # DOMPurify 异步加载
│   └── assets/                # 静态资源（logo.jpg 等）
│
├── noj-judge/                 # 评测 Worker Rust + Docker
│   ├── Cargo.toml             # 依赖：tokio, bollard, redis-rs, reqwest, axum, zip, tar, ...
│   ├── Cargo.lock             # 版本锁定（提交到 git）
│   ├── .dockerignore          # 排除 target/ tests/ docker/
│   ├── Dockerfile.e2e         # E2E 测试多阶段构建
│   ├── docker/python/Dockerfile  # 评测运行时（python:3.12-slim）
│   ├── src/
│   │   ├── main.rs            # 入口（容器池 + dual container）
│   │   ├── lib.rs             # 库入口（暴露给集成测试）
│   │   ├── config.rs          # 环境变量配置
│   │   ├── types.rs           # JudgeTask / JudgeResult / CaseResult
│   │   ├── mq.rs              # Redis MQ 拉取/推送（重试 + 文件 fallback）
│   │   ├── mq/rpc.rs          # Redis RPC（core↔judge）
│   │   ├── sandbox/           # 沙箱
│   │   │   ├── mod.rs
│   │   │   ├── container.rs   # 容器生命周期 + zip 解压
│   │   │   ├── download.rs    # noj-download:// 下载（base64 / s3）
│   │   │   └── cache.rs       # 内容寻址缓存
│   │   ├── judge/             # 评测核心
│   │   │   ├── mod.rs
│   │   │   └── runner.rs      # ---RESULT--- 解析 + 超时/OOM 检测
│   │   ├── pool/              # 容器池
│   │   │   ├── mod.rs         # PoolManager（懒回补 + 健康检查）
│   │   │   ├── copy.rs        # tar 打包 + docker exec 注入
│   │   │   └── exec.rs        # docker exec + cgroup 内存读取
│   │   └── dual/              # 双容器架构（新）
│   │       ├── mod.rs
│   │       ├── container.rs
│   │       └── protocol.rs
│   └── tests/                 # 7 个 E2E 测试 + common/
│
├── noj-tests/                 # 跨模块全链路 E2E 测试
│   ├── deno.json              # task: deno test -A --env-file=../env.e2e.template e2e/
│   ├── E2E_TESTING.md         # 测试指南
│   ├── run-e2e.sh             # 启动脚本
│   └── e2e/                   # 17 个 .test.ts（含 helper.ts）
│       ├── 01_categories.test.ts ... 07_queue.test.ts
│       ├── 08_password_change_guard / 08_problem_template / 08_search
│       ├── 09_checkin / 10_sse / 11_messaging / 12_audit_log
│       ├── 13_support_package_s3 / 14_rejudge / 15_dual_container_judge
│
├── openspec/                  # OpenSpec 规范驱动开发
│   ├── config.yaml            # schema: spec-driven
│   ├── specs/                 # 56 个主规范
│   └── changes/               # 49 个已归档 + 4 个活跃
│       ├── add-noj-docs
│       ├── dual-container-judge
│       ├── remove-single-container-mode
│       └── archive/
│
├── scripts/                   # 构建与运维脚本
│   ├── dev/                   # 本地一键启停 core/ui/judge（13 个脚本）
│   ├── db/                    # 数据库迁移与种子
│   ├── build/                 # 题目支持包构建
│   └── e2e/                   # E2E 编排（setup / teardown / core / judge / run-all）
│
├── .github/workflows/
│   ├── ci.yml                 # PR/推送：并行 fmt + lint + test + build
│   └── e2e.yml                # 全链路管道（17 + 7 ≈ 24 个测试，5-15min）
│
├── docker-compose.yml         # 开发基础设施（PG:5432 + Redis:6379）
├── docker-compose.e2e.yml     # E2E 测试编排（含 noj-core + noj-judge）
├── env.e2e.template           # E2E 环境变量模板（DATABASE_URL=e2e@5433）
│
├── .claude/                   # Claude Code 配置（skills / commands / settings / workflows / worktrees）
├── .opencode/                 # OpenCode 配置（commands / skills）
├── skills-lock.json           # 技能锁定
│
├── AGENTS.md                  # 本文档（AI 入口）
├── CLAUDE.md -> AGENTS.md     # Claude Code 软链
├── README.md                  # 用户面向 README
├── ROADMAP.md                 # 开发路线图
└── LICENSE                    # AGPL-3.0
```

---

## 4. 技术栈与依赖

### 4.1 关键依赖版本

**noj-core**（`deno.lock` + `deno.json`）：

| 依赖 | 版本 | 用途 |
|------|------|------|
| hono | ^4 | Web 框架 |
| drizzle-orm | 0.45.2 | ORM |
| postgres | 3.4.5 | PG 驱动 |
| ioredis | 5.11.1 | Redis 客户端 |
| bcryptjs | ^2.4.3 | 密码哈希 |
| jose | ^5 | JWT |
| @std/encoding | ^1 | base64 / hex |
| @alicloud/dm20151123 | ^1.10.2 | 阿里云邮件 |
| @electric-sql/pglite | ^0.5.3 | 测试用嵌入式 PG |
| @aws-sdk/client-s3 + s3-request-presigner | ^3 | S3 对象存储 |

**noj-ui**（`package.json` + `deno.json`）：nuxt@^4, vue, tailwindcss, @nuxtjs/tailwindcss, @tailwindcss/typography, monaco-editor, sweetalert2, markdown-it, katex, highlight.js, dompurify, @lucide/vue

**noj-judge**（`Cargo.toml`）：

| 依赖 | 版本 | 用途 |
|------|------|------|
| redis | 0.27 (tokio-comp) | Redis 客户端 |
| tokio | 1 (full) | 异步运行时 |
| bollard | 0.21 | Docker API |
| reqwest | 0.12 (rustls-tls) | HTTP 客户端（presigned 下载） |
| zip | 2 (deflate) | 支持包解压 |
| serde / serde_json | 1 | 序列化 |
| anyhow | 1 | 错误处理 |
| tracing / tracing-subscriber | 0.1 / 0.3 | 日志 |
| uuid | 1 (v4) | UUID |
| base64 | 0.22 | base64 编码 |
| tar | 0.4 | tar 打包 |
| axum | 0.8 | metrics 端点 |

### 4.2 关键 deno.json 任务（noj-core）

```
dev          deno run --watch --env-file=.env -A src/main.ts
start        deno run --env-file=.env -A src/main.ts
setup        deno task build-packages && deno task seed
seed         deno run --env-file=.env -A scripts/seed.ts   # 已自动加载 .env
build-packages  deno run -A scripts/build-packages.ts
db:generate  deno -A npm:drizzle-kit generate --config=./drizzle.config.ts
migrate      deno run -A scripts/migrate.ts --env-file=.env
test:smoke   deno test -A --no-check tests/smoke.test.ts
```

---

## 5. 基础设施与启动

### 5.1 Docker Compose 默认凭据

| 服务 | 镜像 | 端口 | 凭据 |
|------|------|------|------|
| PostgreSQL | `postgres:16-alpine` | 5432 | `noj / noj / noj`（用户 / 密码 / 数据库） |
| Redis | `redis:7-alpine` | 6379 | 无认证 |

数据卷：`redis-data`、`postgres-data`（`docker compose down` 不丢失；`-v` 才删）。

### 5.2 启动顺序（严格）

**noj-core（main.ts）**：

1. JWT_SECRET 强度校验（HS256 ≥ 32 字符，失败则 `Deno.exit(1)`）
2. 数据库迁移（失败为致命错误）
3. 确保 root 系统用户存在（UID=0，admin 角色，随机密码不可登录）
4. 连接 Redis（失败 → degraded 模式，HTTP 仍启动但评测不可用）
5. 启动评测结果消费者（指数退避 1s → 2s → 4s → ... → 30s 自动重连）
6. 启动 HTTP 服务（`Deno.serve({ port }, app.fetch)`）

**noj-judge（main.rs）**：

1. 创建 Tokio 运行时
2. 初始化 tracing 日志
3. 加载环境变量配置
4. Redis PING 验证
5. Docker PING 验证
6. `PoolManager::init`（启动后台任务 + 事件循环）
7. `ctrl_c()` 优雅关闭

### 5.3 一键脚本（推荐）

`scripts/dev/` 提供 13 个启停脚本，统一管理日志与 PID：

```bash
bash scripts/dev/install-deps.sh      # 检测/安装 zip、提示其他依赖
cp scripts/dev/env.example noj-core/.env   # 必填 DATABASE_URL 与 JWT_SECRET（≥32 字符）

bash scripts/dev/start-all.sh         # infra → core → ui → judge
bash scripts/dev/status.sh            # 查看运行状态
bash scripts/dev/stop-all.sh          # 一键停止
```

日志位置：`scripts/dev/logs/{core,ui,judge}.log`（infra 由 docker compose 管理）。

### 5.4 手动分步启动

```bash
# 基础设施
docker compose up -d

# 后端
cd noj-core && deno task setup && deno task dev   # http://localhost:8000

# 前端
cd ../noj-ui && deno task dev                    # http://localhost:3000

# 评测 Worker
cd ../noj-judge && cargo run                      # 需要 Docker daemon
```

三模块可独立启动；只调前端可省 noj-judge。

---

## 6. 数据库 Schema

### 6.1 表清单（17 张）

| 表 | 用途 |
|----|------|
| `users` | 用户账户（密码、角色、封禁状态） |
| `problems` | 题目（含 type: U/P 双题库） |
| `judgeImages` | 评测镜像白名单 |
| `categories` | 题目分类（支持父子层级） |
| `problemsCategories` | 题目-分类多对多关联 |
| `submissions` | 用户提交 |
| `evaluationResults` | 评测结果（耗时/内存/得分） |
| `checkIns` | 每日签到 |
| `passwordResetTokens` | 密码重置令牌 |
| `conversations` | 站内私信会话 |
| `messages` | 站内私信消息 |
| `conversationReads` | 已读状态 |
| `messageDeletions` | 消息删除记录 |
| `systemSettings` | 系统设置（运行时可改） |
| `auditLogs` | 审计日志（90 天保留，可配置） |
| `ipBans` | IP 黑名单 |
| `userBans` | 用户封禁记录 |

### 6.2 迁移

- 共 26 个迁移文件（`drizzle/0000_*.sql` 起）
- 由 `deno task db:generate` 自动生成，**勿手动编辑 `_journal.json`**
- 迁移顺序严格按编号；新迁移只能追加

### 6.3 核心关系

```
users ─< submissions >─ problems
problems >─< problemsCategories >─ categories  (categories 自引用 parent)
users ─< checkIns
users ─< conversations ─< messages
users ─< auditLogs
users ─< userBans / ipBans
submissions ─1:1─ evaluationResults
```

U 型（用户题）：owner/admin 可 CRUD；P 型（主题题）：仅 admin 可 CRUD。

---

## 7. 版本控制与提交规范

### 7.1 Jujutsu (jj)

本地使用 **jj** 管理仓库，推送使用 `jj git push`：

- 无暂存区：`jj describe` 设提交信息，`jj new` 创建新提交
- 误操作：`jj undo` 回退
- 远程：`jj git push`

### 7.2 提交信息（Conventional Commits）

- 格式：`<type>(<scope>): <description>`
- type：`feat` `fix` `docs` `style` `refactor` `perf` `test` `chore` `ci` `build`
- scope：`core` / `ui` / `judge` / `root`；多 scope 用逗号：`fix(core,ui): 描述`
- description 使用**中文**
- 示例：`feat(core): 添加评测任务分发 API` / `fix(judge): 修复容器超时未清理`

### 7.3 项目语言

主要语言为**中文**，以下必须中文：

- 提交信息（type 英文，description 中文）
- 代码注释
- 文档（README、AGENTS.md、ROADMAP.md 等）
- PR 描述与 Issue
- **例外**：代码标识符（变量名、函数名）使用英文

### 7.4 GPG 签名（强制）

所有提交必须 GPG 签名。AI 在修改代码前必须先确认用户已配置签名。

---

## 8. AI 必须遵守的要求

### 8.1 不可逾越的红线

1. **禁止直接推送到 `main`** — 所有变更通过 PR 合入
2. **禁止未签名提交** — GPG 未就绪时不得提交代码，应引导用户配置
3. **禁止跳过 OpenSpec** — 功能性变更必须先有 `/opsx:propose` 提案
4. **禁止修改 `_journal.json`** — Drizzle 迁移元数据由工具管理
5. **禁止修改 `deno.lock` / `Cargo.lock` 手动内容** — 通过 `deno cache` / `cargo update` 更新
6. **禁止在 `.env` 中硬编码真实凭据** — 用 `.env.example` 模板 + `gitignore`
7. **禁止向生产数据库直连变更 schema** — 走 Drizzle 迁移流程

### 8.2 编码规范

- **TypeScript/Deno**：遵循 `deno fmt` + `deno lint`（CI 强制）
- **Rust**：遵循 `cargo fmt` + `cargo clippy`（CI 强制）
- **Vue**：遵循 `deno lint` + `deno fmt`（`include: ["*.vue", "*.ts"]`）
- **中文注释 + 英文标识符**：参考既有代码风格
- **错误处理**：Deno 用 `AppError` 继承体系；Rust 用 `anyhow::Result`
- **日志**：生产环境 `logger` 自动 UUID 截断 + score 隐藏，不得直接 `console.log` 输出敏感字段

### 8.3 修改前必读

进入模块目录前，**先读对应 `CLAUDE.md`**：

| 路径 | 必读 |
|------|------|
| 仓库根 | 本文档 |
| `noj-core/` | `noj-core/CLAUDE.md` |
| `noj-ui/` | `noj-ui/CLAUDE.md` |
| `noj-judge/` | `noj-judge/CLAUDE.md` |

涉及对应领域时主动加载技能：

- TypeScript / Hono / Drizzle → `deno-expert` / `hono` / `supabase-postgres-best-practices`
- Nuxt / Vue → `nuxt` / `vue`
- Rust / Docker / Redis → `docker-expert` / `redis-core`
- 规范变更 → `openspec-*` 技能

### 8.4 改动检查清单

每次完成任务前自查：

- [ ] `deno fmt` / `cargo fmt` 已运行
- [ ] `deno lint` / `cargo clippy` 无警告
- [ ] 新功能/修复有对应测试（core 走 `tests/services`/`routes`；judge 走单元 + E2E）
- [ ] 新表/字段已通过 `deno task db:generate` 生成迁移
- [ ] 新环境变量已加入 `.env.example` + `scripts/dev/env.example`
- [ ] 中文提交描述符合 Conventional Commits
- [ ] GPG 签名可用
- [ ] 若是功能变更，OpenSpec 变更已 `/opsx:propose` 起草

---

## 9. 贡献流程

### 9.1 PR 工作流

```bash
# 1. 基于 main 创建分支
jj new main
jj describe                            # 中文 Conventional Commits

# 2. 推送分支（触发 PR 触发器）
jj git push -b <branch-name>

# 3. 创建 PR
gh pr create --draft                   # Draft PR
gh pr create --fill                    # 直接创建

# 4. 迭代修复
jj new
jj squash
jj git push -b <branch-name> --force

# 5. 合并后同步
jj git fetch
jj new main
jj git push
```

### 9.2 Agent GPG 检查

AI 在修改代码前必须执行：

```bash
gpg --list-secret-keys --keyid-format LONG
git config --global user.signingkey
git config --global commit.gpgsign
jj config get signing.key 2>/dev/null
```

未配置时，说明必要性并引导用户配置，**不得**在签名就绪前提交。

---

## 10. OpenSpec 开发工作流

### 10.1 目录结构

```
openspec/
├── config.yaml              # schema: spec-driven
├── specs/                   # 56 个主规范（活跃）
│   ├── database-schema/     # DB Schema
│   ├── user-auth/           # 用户认证
│   ├── problem-*/           # 题目管理
│   ├── judge-*/             # 评测相关
│   ├── admin-*/             # 管理后台
│   ├── container-pool/      # 容器池
│   ├── checkin/             # 每日签到
│   ├── private-messaging/   # 站内私信
│   ├── sse-*/               # SSE 推送
│   ├── ranking/             # 榜单
│   └── ...（共 56 个）
└── changes/                 # 变更提案
    ├── add-noj-docs/        # 活跃
    ├── dual-container-judge/# 活跃
    ├── remove-single-container-mode/  # 活跃
    └── archive/            # 49 个已归档
```

### 10.2 工作流（强制）

任何功能性变更**必须**按以下顺序：

1. **`/opsx:explore`** — 探索现有相关规范
2. **`/opsx:propose`** — 起草变更提案（含设计文档 + Delta 规范 + 任务拆分）
3. 评审 → 实现
4. **`/opsx:apply`** — 实施（按任务推进）
5. 测试通过后 **`/opsx:archive`** — 归档变更

`/opsx:sync` 用于把已归档变更的增量同步到主规范。

### 10.3 活跃变更示例

当前活跃变更集中在评测容器架构演进：

- `add-noj-docs` — 增加文档站（MkDocs Material）
- `dual-container-judge` — 评测从单容器迁移到双容器
- `remove-single-container-mode` — 移除单容器兼容路径

---

## 11. 安全模型

### 11.1 认证

- JWT HS256，iss/aud 校验（iss=`nj-core`，aud=`nj-ui`）
- HTTP-only Cookie `noj:token`（JS 不可见，防 XSS）
- 登录额外设置可读 Cookie `noj:session`（仅用于 UI 快速判断）
- 24h 过期（`JWT_EXPIRES_IN` 可配）
- 无刷新令牌；无 jti 持久化（已知限制）

### 11.2 密码安全

- bcrypt cost 12（OWASP 2025+ 最低）
- 最小 12 字符，含大小写字母 + 数字
- 不能与 username/email 前缀相同

### 11.3 速率限制（`noj-core/.env`）

```
RATE_LIMIT_ENABLED=true
RATE_LIMIT_LOGIN_IP_WINDOW=30         # 30s 窗口
RATE_LIMIT_LOGIN_IP_MAX=10            # 单 IP 最多 10 次
RATE_LIMIT_LOGIN_ACC_WINDOW=30        # 30s 窗口
RATE_LIMIT_LOGIN_ACC_MAX=5            # 单账号最多 5 次
RATE_LIMIT_LOGIN_BACKOFF_SEC=15       # 每次失败 +15s 退避
RATE_LIMIT_LOGIN_LOCK_THRESHOLD=10    # 连续 10 次失败锁定
RATE_LIMIT_LOGIN_LOCK_SECONDS=3600    # 锁定 1 小时
TRUSTED_PROXIES=                      # 留空则开发模式直接信任 XFF；生产必须配置
NOJ_ENV=test 时强制关闭
```

### 11.4 容器安全（noj-judge）

- `cap_drop ALL` — 移除所有 Linux 能力
- `no-new-privileges` — 禁止提权
- `network_mode none` — 完全隔离网络
- `ipc_mode none` — 禁止 IPC 共享
- `pids_limit 256`
- `tmpfs /tmp`（256M）

### 11.5 ZIP 安全（硬编码）

- 路径穿越防护：拒绝 `..` 或 `/` 开头的条目
- 炸弹防护：1000 条目 / 64MB 单文件 / 512MB 总解压

### 11.6 存储与邮件 Provider

```
STORAGE_PROVIDER=local | s3           # 必填
EMAIL_PROVIDER=mock | aliyun | tencent # 默认 mock（仅输出到控制台）
```

S3 配置：`S3_ENDPOINT / S3_REGION / S3_ACCESS_KEY / S3_SECRET_KEY / S3_BUCKET / S3_FORCE_PATH_STYLE`。

### 11.7 授权与防护

- 服务端强制校验角色（UI session cookie 仅展示）
- admin 可创建任意 type；普通用户仅限 U 型
- P 型仅 admin CRUD；U 型 owner/admin CRUD
- 禁止降级最后一个可登录 admin
- root 用户（UID=0）不计入管理员统计
- XSS：HTTP-only Cookie + DOMPurify Markdown 清洗
- CSRF：Cookie `sameSite: 'lax'`（已知无 token）
- CORS：开发 `*`；生产仅白名单域名；`credentials: true, maxAge: 86400`
- 日志安全（`NOJ_ENV=production`）：submission_id 截断前 8 字符、score 隐藏、DB 密码脱敏
- 审计日志保留 90 天（`AUDIT_LOG_RETENTION_DAYS` 可配置；0 = 禁用）

### 11.8 已知限制（设计决策）

- 无刷新令牌 / 无 JWT 撤销
- 无 CSRF token（依赖 sameSite）
- 无速率限制图形验证码
- 注册存在 TOCTOU 竞争（DB 唯一约束为最终保障）

---

## 12. 测试体系

### 12.1 noj-core（67 个测试文件）

```bash
cd noj-core && deno task test
```

- DB 依赖测试检查 `DATABASE_URL` / `JWT_SECRET`，缺失时静默跳过
- `sanitizeResources: false, sanitizeOps: false`
- 路由测试使用 `jsonRequest()` 辅助函数
- 测试数据用 `Date.now()` 生成唯一 username/email
- 单元模块测试：`tests/lib/`、`tests/services/`、`tests/middleware/`
- 集成测试：`tests/routes/`、`tests/mq/`
- 性能测试：`tests/perf/`
- 冒烟测试：`deno task test:smoke`

### 12.2 noj-judge

**单元测试**（无需 Docker）：

```bash
cd noj-judge && cargo test --lib
```

**Docker 沙箱 E2E**（7 个 `e2e_*.rs`）：

```bash
cd noj-judge && NOJ_RUN_E2E=1 cargo test --test e2e -- --ignored
```

- 集成测试 `#[ignore]` + `NOJ_RUN_E2E=1` 守卫
- `#[serial_test::serial]` 序列化执行避免 Docker 资源竞争
- 30s 外层超时：`tokio::time::timeout(30s, ...)`

### 12.3 跨模块 E2E（noj-tests，17 个测试文件）

```bash
cd noj-tests && deno task test
```

- `deno.json` task 已自动 `--env-file=../env.e2e.template`，**无需前缀 `NOJ_RUN_E2E=1`**
- 覆盖：Accepted / WrongAnswer / TLE / MQ 可靠性 / 无效消息容错 / 鉴权守卫 / S3 存储 / SSE / 私信 / 审计日志 / 重测 / 双容器等
- 辅助启动：`./run-e2e.sh`

---

## 13. CI/CD

### 13.1 GitHub Actions

**`ci.yml`** — PR/推送触发，并行检查三个模块：

| Job | 检查项 | 依赖服务 |
|-----|--------|----------|
| core-test | deno fmt, deno lint, deno test | PostgreSQL + Redis |
| ui-check | deno lint, deno fmt, npm install, nuxt build | 无 |
| judge-check | cargo fmt, clippy, build, test | 无 |
| judge-e2e | cargo test --ignored | Docker（手动触发 workflow_dispatch） |

**`e2e.yml`** — 全链路管道测试（PR/推送 main）：

- 构建支持包 + 评测镜像 + Docker Compose
- 启动完整评测栈（noj-core + noj-judge + PG:5433 + Redis:6380）
- 运行 noj-tests E2E（17 个测试）
- 运行 noj-judge Docker 沙箱 E2E（7 个测试）
- 首次 ~15min，缓存命中后 ~5-8min
- 超时 60min，`always()` 输出诊断日志
- env：`JWT_SECRET=e2e-ci-secret-fixed-value-with-32-chars-min-abc`（≥32 字符，main.ts 强校验）

---

## 14. 故障排查速查

| 现象 | 处理 |
|------|------|
| `JWT_SECRET 长度不足 32` | 在 `noj-core/.env` 设置 32+ 字符随机串（`openssl rand -base64 48`） |
| `DATABASE_URL` 连接拒绝 | `docker compose ps` 确认 PG 启动；端口 5432 未占用 |
| `zip: command not found` | `sudo apt install -y zip unzip` 或先跑 `install-deps.sh` |
| `Cannot connect to Docker daemon` | 启动 Docker Desktop 或 `sudo systemctl start docker` |
| 端口 3000 / 8000 冲突 | `lsof -i :3000` 杀掉占用或修改 `PORT` |
| 提交后长时间 `Pending` | noj-judge 未启/未连 Redis；查 `scripts/dev/logs/judge.log` |
| 队列堆积 | `redis-cli LLEN noj:judge:queue`；重启 noj-judge 触发自动重连 |
| `noj-download://` 解码失败 | `deno task build-packages` 重建支持包 |
| `image not found` | 默认镜像 `noj-judge-python`；检查 `noj-judge/docker/` 构建脚本 |
| 迁移失败 | `cd noj-core && deno task migrate` 看脱敏日志 |
| 种子数据缺失 | 确认 `noj-core/.env` 已配 `ADMIN_EMAIL`；重新 `deno task seed` |
| 想清空重置 | `docker compose down -v` 删卷后 `up -d` + `deno task setup` |
| `deno task migrate` 不读 .env | deno.json task 已显式 `--env-file=.env`，正常应工作 |

日志位置：`scripts/dev/logs/{core,ui,judge}.log`；前端队列状态页：<http://localhost:3000/queue>。

---

## 15. 项目状态与路线图

当前处于 **Phase 1（MVP）** 阶段——已打通"注册 → 做题 → 提交 → 评测结果"闭环，具备题目筛选、管理后台、用户榜单、每日签到、站内私信。

| 阶段 | 交付标准 | 状态 |
|------|---------|------|
| **Phase 0** | 浏览器注册 → 做题 → 提交 → 看到评测结果 | ✅ 完成 |
| **Phase 1** | 榜单可查，题目可筛选，管理后台可用 | 🚧 进行中（遗留：多语言 C++/Java/Node.js、SPJ） |
| **Phase 2** | 可创建比赛 → 用户参赛 → 实时榜单 → 赛后复盘 | ⏳ 规划 |
| **Phase 3** | 多 Worker 并发评测，99.5% 可用性 | ⏳ 规划 |

详见 [`ROADMAP.md`](./ROADMAP.md)。

### 已知遗留

- **前端**：无 SEO（无 OG 标签 / sitemap）、无图片优化、无 web fonts（系统字体栈）、无单独 `types/` 目录、Composable 命名不一致（`useAuth` vs `use-submissions`）

---

## 16. 参考文档

| 文档 | 路径 | 用途 |
|------|------|------|
| 用户 README | [`README.md`](./README.md) | 用户面向的项目说明 |
| noj-core 详细文档 | [`noj-core/CLAUDE.md`](./noj-core/CLAUDE.md) | Deno + Hono 后端完整约定 |
| noj-ui 详细文档 | [`noj-ui/CLAUDE.md`](./noj-ui/CLAUDE.md) | Nuxt + Vue 前端完整约定 |
| noj-judge 详细文档 | [`noj-judge/CLAUDE.md`](./noj-judge/CLAUDE.md) | Rust Worker 完整约定 |
| E2E 测试指南 | [`noj-tests/E2E_TESTING.md`](./noj-tests/E2E_TESTING.md) | 跨模块 E2E 测试方法 |
| 开发路线图 | [`ROADMAP.md`](./ROADMAP.md) | 阶段规划与待办 |
| AI 入口（本文档） | [`AGENTS.md`](./AGENTS.md) | AI 编码助手项目知识库 |
| OpenSpec 主规范 | [`openspec/specs/`](./openspec/) | 56 个行为规范 |

---

*本文档为顶层 AI 入口。各模块详细约定、API 端点、Schema 字段、组件层级请参考对应子目录 `CLAUDE.md`。*