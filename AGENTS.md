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
15. [参考文档](#15-参考文档)

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
| **noj-core** | Deno 2 + Hono | RESTful API、JWT 鉴权 + RBAC 权限、用户/题目/提交/榜单/竞赛/社区 CRUD、全局搜索、Redis MQ Producer 与 Consumer、审计日志 |
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
  "problem_id": "uuid",
  "download_url": "noj-download://base64/?content=UEsDBBQAAAAIA...&checksum_sha256=abc123",
  "runtime_config": {
    "evaluator": {
      "image": "noj-judge-python",
      "command": "python3 /workspace/evaluate.py",
      "time_limit_ms": 5000,
      "memory_limit_mb": 512
    },
    "solution": {
      "image": "noj-judge-python",
      "entry": "solution.py",
      "call_timeout_ms": 2000,
      "memory_limit_mb": 512
    }
  },
  "language": "python3",
  "code": "...",
  "file_name": "submission.py",
  "rejudge_seq": 1
}
```

> 双容器架构后 `judge_image` / `judge_command` / `time_limit_ms` / `memory_limit_mb`
> 顶层字段已移除，统一由 `runtime_config`（Evaluator + Solution）承载。

### 1.4 双层 URL 设计

| 层级 | URL 前缀 | 用途 | 字段 |
|------|---------|------|------|
| **DB 存储层** | `noj-storage://` | 标识资源在存储后端的位置 | `support_package_storage_url` |
| **Judge 交付层** | `noj-download://` | 描述 judge 如何获取支持包内容 | `JudgeTask.download_url` |

- `local` 模式：`noj-storage://local/<base64>` ↔ `noj-download://base64/?content=[base64]`
- `s3` 模式：`noj-storage://s3/<key>` ↔ `noj-download://s3?url=[presigned]`
- SHA-256 校验贯穿两个层级，支持内容寻址缓存
- 用户提交的代码**不**进支持包，由 noj-judge 运行时注入
- 支持包（zip）由 `deno task problems:build` 从 `data/problems-src/<id>/` 构建

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
│   ├── drizzle/               # SQL 迁移文件（自动生成，勿手改 _journal.json）
│   ├── .env.example           # 环境变量模板（不提交 .env）
│   ├── src/
│   │   ├── main.ts            # 入口（启动校验 + 初始化顺序）
│   │   ├── app.ts             # Hono 应用工厂（CORS + 路由 + 错误处理）
│   │   ├── mod.ts             # 公共导出
│   │   ├── routes/            # 路由：admin / auth / categories / checkin / community / contests / conversations / health / problems / queue / rankings / search / sse / stats / submissions / users
│   │   ├── services/          # 业务逻辑层：auth / categories / checkin / community / contests / conversations / dashboard / messages / problems-* / queue / rankings / search / submissions-* / support-package / system-settings / users / admin-roles / audit-log / banlist / judge-images / passwordReset / stats-cache / seed-rbac / community-seed 等
│   │   ├── db/
│   │   │   ├── connection.ts  # 数据库连接管理（单例）
│   │   │   ├── migrate.ts     # 迁移执行器（绝对路径解析）
│   │   │   └── schema.ts      # Drizzle 表定义
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
│   │   ├── noj.ts             # 管理 CLI 单入口（Cliffy：db migrate / init system / bootstrap admin / problems build / problems import / dev-setup）
│   │   ├── check-env.ts       # 环境变量校验
│   │   └── migrate.ts         # 迁移脚本（密码脱敏）
│   ├── data/
│   │   ├── problems-src/      # 题目源文件（版本控制）
│   │   │   ├── 1001/          # "星港舱门报码归一化" (easy)
│   │   │   ├── 1002/          # "传感器数据滤波" (medium, 无支持包)
│   │   │   └── 1003/          # "A+B Problem" (easy)
│   │   └── packages/          # 构建产物 (gitignored，local 模式)
│   └── tests/                 # 测试文件（与 src 镜像结构，以实际为准）
│       ├── 00_migrate_test.ts # 迁移 + seed root 用户（最先执行）
│       ├── app.test.ts, smoke.test.ts
│       ├── services/          # 服务层测试
│       ├── routes/            # 路由层测试（jsonRequest() 辅助）
│       ├── lib/               # 工具函数测试
│       ├── middleware/, mq/, db/, types/, perf/, data/
│
├── noj-ui/                    # 前端 Nuxt 4 + Vue 3
│   ├── deno.json              # 任务 + npm 兼容（nodeModulesDir: auto）
│   ├── package.json           # @noj/ui（@nuxt/ui + tailwindcss + monaco-editor）
│   ├── nuxt.config.ts         # vite, nitro preset, runtimeConfig
│   ├── app.vue                # 根组件 + CSS 变量
│   ├── pages/                 # 文件路由：index / login / register / problems / submissions / ranking / queue / contests / community / messages / search / settings / users / admin / editor 等
│   ├── components/            # 按功能分目录：layout/（Navbar、FooterBar、Sidebar）/ editor/（MonacoEditor、ProblemEditor）/ feature/（ProblemFilterBar、CheckInCard、SearchPalette、社区组件）/ shared/（MarkdownRenderer、PaginationNav）/ ui/（StatusBadge、AsyncContent 等）/ admin/ / auth/ / card/ / form/
│   ├── composables/           # useApi（统一 API 调用层）/ useAuth / usePolling / useToast / useDialog / useProblemFilters / use-submissions / useCommunity / useContests / useMessages / useSearch / useRankings / useEventSource / useAdminList 等
│   ├── layouts/               # default / auth / admin
│   ├── server/
│   │   ├── api/[...slug].ts   # Nitro 代理（拦截登录 + JWT 注入）
│   │   └── api/auth/logout.post.ts # 本地注销
│   ├── middleware/            # auth（5s 超时）+ admin（静默重定向）+ community-moderation（社区审核员）
│   ├── utils/sanitize.ts      # DOMPurify 异步加载
│   └── assets/                # 静态资源（logo.jpg 等）
│
├── noj-judge/                 # 评测 Worker Rust + Docker
│   ├── Cargo.toml             # 依赖：tokio, bollard, redis-rs, reqwest, zip, tar, ...
│   ├── Cargo.lock             # 版本锁定（提交到 git）
│   ├── .dockerignore          # 排除 target/ tests/ docker/
│   ├── Dockerfile.e2e         # E2E 测试多阶段构建
│   ├── docker/python/Dockerfile  # 评测运行时（python:3.12-slim）
│   ├── src/
│   │   ├── main.rs            # 入口（容器池 + dual container）
│   │   ├── lib.rs             # 库入口（暴露给集成测试）
│   │   ├── config.rs          # 环境变量配置
│   │   ├── types.rs           # JudgeTask / JudgeResult / CaseResult
│   │   ├── drain.rs           # 优雅关闭时排空 in-flight 任务
│   │   ├── mq.rs              # Redis MQ 拉取/推送（重试 + 文件 fallback）
│   │   ├── mq/rpc.rs          # Redis RPC（core↔judge）
│   │   ├── sandbox/           # 沙箱
│   │   │   ├── mod.rs
│   │   │   ├── container.rs   # 容器生命周期 + zip 解压
│   │   │   ├── download.rs    # noj-download:// 下载（base64 / s3）
│   │   │   ├── cache.rs       # 内容寻址缓存
│   │   │   ├── cleanup.rs     # 孤儿容器清理
│   │   │   └── host_config.rs # 容器 HostConfig 构造（安全项）
│   │   ├── judge/             # 评测核心
│   │   │   ├── mod.rs
│   │   │   └── runner.rs      # ---RESULT--- 解析 + 超时/OOM 检测
│   │   ├── pool/              # 容器池
│   │   │   ├── mod.rs         # PoolManager（懒回补 + 健康检查）
│   │   │   ├── copy.rs        # tar 打包 + docker exec 注入
│   │   │   └── exec.rs        # docker exec + cgroup 内存读取
│   │   └── dual/              # 双容器架构（Evaluator + Solution，NDJSON 编排）
│   │       ├── mod.rs
│   │       ├── container.rs
│   │       └── protocol.rs
│   └── tests/                 # 独立 E2E test binary（e2e_docker_basic / e2e_resource_limits / e2e_security_isolation / e2e_support_package / e2e_container_pool / e2e_problem_limits / e2e_dual_container）+ common/ + e2e/
│
├── noj-tests/                 # 跨模块全链路 E2E 测试
│   ├── deno.json              # task: deno test -A --env-file=../env.e2e.template e2e/
│   ├── E2E_TESTING.md         # 测试指南
│   ├── run-e2e.sh             # 启动脚本
│   └── e2e/                   # E2E 测试文件（含 helper.ts），覆盖评测 / 竞赛 / 社区 / RBAC / S3 / SSE / 私信 / 审计 / 重测 / 双容器等
│
├── openspec/                  # OpenSpec 规范驱动开发
│   ├── config.yaml            # schema: spec-driven
│   ├── specs/                 # 主规范
│   └── changes/               # 已归档（archive/）+ 当前活跃变更（以目录实际为准）
│
├── scripts/                   # 构建与运维脚本
│   ├── dev/                   # devtool.sh 单文件编排（install-deps / init-env / start / stop / status）+ env.example + logs/ + locks/
│   ├── db/                    # 数据库迁移与种子
│   ├── build/                 # 题目支持包构建
│   └── e2e/                   # E2E 编排（setup / teardown / core / judge / run-all）
│
├── .github/workflows/
│   ├── ci.yml                 # PR/推送：并行 fmt + lint + test + build
│   └── e2e.yml                # 全链路管道（noj-tests + noj-judge 全量测试）
│
├── docker-compose.yml         # 开发基础设施（PG:5432 + Redis:6379）
├── docker-compose.e2e.yml     # E2E 测试编排（含 noj-core + noj-judge + MinIO）
├── env.e2e.template           # E2E 环境变量模板（DATABASE_URL=e2e@5433）
│
├── .claude/                   # Claude Code 配置（skills / commands / settings / workflows / worktrees）
├── .opencode/                 # OpenCode 配置（commands / skills）
├── skills-lock.json           # 技能锁定
│
├── noj-docs/                  # 用户文档站（MkDocs Material：做题人/运营者/出题人/参考）
│
├── AGENTS.md                  # 本文档（AI 入口）
├── CLAUDE.md -> AGENTS.md     # Claude Code 软链
├── README.md                  # 用户面向 README
└── LICENSE                    # AGPL-3.0
```

---

## 4. 技术栈与依赖

### 4.1 关键依赖

**noj-core**（`deno.lock` + `deno.json`）：

| 依赖 | 用途 |
|------|------|
| hono | Web 框架 |
| drizzle-orm | ORM |
| postgres | PG 驱动 |
| ioredis | Redis 客户端 |
| bcryptjs | 密码哈希 |
| jose | JWT |
| @std/encoding | base64 / hex |
| @alicloud/dm20151123 | 阿里云邮件 |
| @electric-sql/pglite | 测试用嵌入式 PG |
| @aws-sdk/client-s3 + s3-request-presigner | S3 对象存储 |

**noj-ui**（`package.json`）：nuxt, vue, @nuxt/ui, tailwindcss, @nuxt/icon + @iconify-json/lucide, @nuxt/fonts, @nuxtjs/color-mode, monaco-editor, markdown-it, katex, highlight.js, dompurify

**noj-judge**（`Cargo.toml`，完整列表以 Cargo.toml 为准）：

| 依赖 | 用途 |
|------|------|
| redis | Redis 客户端（tokio-comp 特性） |
| tokio | 异步运行时（full 特性） |
| bollard | Docker API |
| reqwest | HTTP 客户端（rustls-tls、presigned 下载） |
| zip | 支持包解压（deflate） |
| serde / serde_json | 序列化 |
| anyhow | 错误处理 |
| tracing / tracing-subscriber | 日志 |
| uuid | UUID（v4 生成） |
| base64 | base64 编码 |
| tar | tar 打包 |
| sha2 / percent-encoding / filetime / gethostname / tokio-util / futures-util / tempfile / serial_test | 哈希 / URL 编码 / 文件时间 / 主机名 / 任务编排 / 测试辅助 |

### 4.2 关键 deno.json 任务（noj-core）

```
dev          deno run --watch --env-file=.env -A src/main.ts
start        deno run --env-file=.env -A src/main.ts
db:migrate   deno run --env-file=.env -A scripts/noj.ts db migrate
init:system  deno run --env-file=.env -A scripts/noj.ts init system
bootstrap:admin  deno run --env-file=.env -A scripts/noj.ts bootstrap admin
problems:build   deno run -A scripts/noj.ts problems build
problems:import  deno run --env-file=.env -A scripts/noj.ts problems import
dev-setup    deno run --env-file=.env -A scripts/noj.ts dev-setup
db:generate  deno -A npm:drizzle-kit generate --config=./drizzle.config.ts
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

`scripts/dev/devtool.sh` 是单文件编排工具，整合原独立脚本（`install-deps` / `start-{all,infra,core,ui,judge}` / `stop-{all,infra,core,ui,judge}` / `status`），通过子命令分发：

```bash
bash scripts/dev/devtool.sh install-deps --check-only   # 检测 zip / Deno / Rust / Docker
bash scripts/dev/devtool.sh init-env                    # 首次：复制 env.example → noj-core/.env
bash scripts/dev/devtool.sh start                      # 默认 all：infra → core → ui → judge
bash scripts/dev/devtool.sh status                     # 查看运行状态
bash scripts/dev/devtool.sh stop                       # 反向顺序停止全部
```

子命令 `start` / `stop` 接受 TARGET：`infra | core | ui | judge | all`（默认 `all`），支持单模块启停（如 `devtool.sh start ui`）。`status` 支持 `--json` 与 `--watch SECS`，`init-env` 支持 `--merge`（追加模板缺失键）/ `--force`（覆盖），`start judge` 支持 `--build`（强制重编译）。

日志位置：`scripts/dev/logs/{core,ui,judge}.log`（infra 由 docker compose 管理）。PID 锁：`scripts/dev/locks/<target>.lock`（同工具防双开）。详细用法见 `bash scripts/dev/devtool.sh help`。

### 5.4 手动分步启动

```bash
# 基础设施
docker compose up -d

# 后端
cd noj-core && deno task dev-setup && deno task dev   # http://localhost:8000

# 前端
cd ../noj-ui && deno task dev                    # http://localhost:3000

# 评测 Worker
cd ../noj-judge && cargo run                      # 需要 Docker daemon
```

三模块可独立启动；只调前端可省 noj-judge。

或统一通过 `scripts/dev/devtool.sh` 编排（见 §5.3）：`devtool.sh start core` 等价于上面 `cd noj-core && deno task dev` 的封装。

---

## 6. 数据库 Schema

### 6.1 表清单（完整定义以 `src/db/schema.ts` 为准）

**核心业务**

| 表 | 用途 |
|----|------|
| `users` | 用户账户（密码、角色、封禁状态） |
| `problems` | 题目（含 type: U/P 双题库） |
| `judgeImages` | 评测镜像白名单 |
| `categories` / `problemsCategories` | 题目分类（父子层级）+ 多对多关联 |
| `submissions` / `evaluationResults` | 用户提交 / 评测结果（耗时/内存/得分） |
| `checkIns` | 每日签到 |
| `passwordResetTokens` | 密码重置令牌 |
| `systemSettings` | 系统设置（运行时可改） |
| `auditLogs` | 审计日志（90 天保留，可配置） |
| `ipBans` / `userBans` | IP 黑名单 / 用户封禁记录 |

**站内私信**

| 表 | 用途 |
|----|------|
| `conversations` / `messages` / `conversationReads` / `messageDeletions` | 会话 / 消息 / 已读状态 / 删除记录 |

**竞赛（Phase 2）**

| 表 | 用途 |
|----|------|
| `contests` / `contestProblems` / `contestParticipants` / `contestClarifications` | 竞赛、题目集、参赛者、答疑（Clarification API 待实现） |

**RBAC（#171）**

| 表 | 用途 |
|----|------|
| `roles` / `permissions` / `rolePermissions` / `userRoles` | 角色 / 权限（`resource:action`）/ 关联表 |

**社区（#178）**

| 表 | 用途 |
|----|------|
| `communityBoards` / `communityBoardRoleGrants` | 板块 / 角色授权 |
| `communityPosts` / `communityComments` / `communityPostLikes` / `communityCommentLikes` / `communityBookmarks` / `communityFollows` / `communityActivityEvents` | 帖子 / 评论 / 点赞 / 收藏 / 关注 / 动态流 |
| `communityReports` / `communityModerationActions` / `communitySanctions` / `communityNotifications` | 举报 / 审核动作 / 处罚 / 通知 |

### 6.2 迁移

- 迁移文件（`drizzle/0000_*.sql` 起）
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
- 文档（README、AGENTS.md、各模块 CLAUDE.md 等）
- PR 描述与 Issue
- **例外**：代码标识符（变量名、函数名）使用英文

### 7.4 GPG 签名（强制）

所有提交必须 GPG 签名。AI 在修改代码前必须先确认用户已配置签名。

### 7.5 OpenSpec 归档目录命名（强制）

OpenSpec 变更归档到 `openspec/changes/archive/` 时，目录名必须遵循：

- **格式**：`YYYY-MM-DD-<kebab-case-name>`
- **日期**：归档当日（UTC+8）的日期
- **name**：与原 `openspec/changes/<name>/` 中的 `<name>` 完全一致（不重新命名）
- **正确**：`2026-07-25-add-noj-docs/`、`2026-07-25-dual-container-judge/`
- **错误**：`2026-07-06-2026-06-27-daily-checkin/`（双重日期，混淆了"原变更日"与"归档日"）

禁止带 `git mv` 之外的拷贝方式（保留历史）。如果发现双重日期或格式不一致的归档目录，**新归档不要复用旧名**，直接以当日日期 + 原名建立新目录。

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
8. **优先使用开发工具（脚本）** — 标准操作（启停模块、查看状态、构建支持包、迁移数据库等）应先查 `scripts/` 下的开发脚本再动手；存在封装脚本时优先使用脚本而非手动拼接命令

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
- [ ] 优先使用 `scripts/` 下的开发工具脚本完成标准操作，而非手动拼接命令

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
├── specs/                   # 主规范（活跃）
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
│   ├── contest-*/           # 竞赛
│   ├── community-*          # 社区
│   └── ...
└── changes/                 # 变更提案
    ├── <active-name>/       # 活跃变更（以实际目录为准）
    └── archive/             # 已归档
```

### 10.2 工作流（强制）

任何功能性变更**必须**按以下顺序：

1. **`/opsx:explore`** — 探索现有相关规范
2. **`/opsx:propose`** — 起草变更提案（含设计文档 + Delta 规范 + 任务拆分）
3. 评审 → 实现
4. **`/opsx:apply`** — 实施（按任务推进）
5. 测试通过后 **`/opsx:archive`** — 归档变更

`/opsx:sync` 用于把已归档变更的增量同步到主规范。

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

### 12.1 noj-core

```bash
cd noj-core && deno task test           # 串行全量（无 DATABASE_URL → PGlite 内存库）
cd noj-core && deno task test:parallel  # 并行分片（TEST_SCHEMA=test_unit/test_db 双 schema）
```

- DB 依赖测试检查 `DATABASE_URL` / `JWT_SECRET`，缺失时静默跳过
- `sanitizeResources: false, sanitizeOps: false`
- 路由测试使用 `jsonRequest()` 辅助函数
- 测试数据用 `Date.now()` 生成唯一 username/email
- 单元模块测试：`tests/lib/`、`tests/services/`、`tests/middleware/`
- 集成测试：`tests/routes/`、`tests/mq/`
- 性能测试：`tests/perf/`（`NOJ_RUN_PERF=1` guard，默认不跑；CI 仅 main push / 手动触发）
- 冒烟测试：`deno task test:smoke`
- **并行分片**（2026-07 引入）：`scripts/test-parallel.ts` 将测试按目录分为
  unit / db 两组，通过 `TEST_SCHEMA`（`connection.ts` 的 libpq
  `-csearch_path` startup 参数）+ `migrationsSchema` 隔离到独立 PG schema，
  进程级并行无死锁（原 `deno test --parallel` 因 TRUNCATE 互锁不可用）
- **历史迁移陷阱**：0010/0027/0029 迁移 SQL 曾含 drizzle-kit 生成的
  `REFERENCES "public"."xxx"` 硬编码前缀（分片下 FK 错指 public，已修复）。
  新增迁移保持不带 schema 前缀

### 12.2 noj-judge

**单元测试**（无需 Docker，推荐 cargo-nextest 并行执行）：

```bash
cd noj-judge && cargo nextest run --all-targets
cd noj-judge && cargo test              # 等价（无 doctest）
```

**Docker 沙箱 E2E**（`e2e_*.rs` test binary，需 Docker daemon）：

```bash
cd noj-judge && NOJ_RUN_E2E=1 cargo test --test e2e_docker_basic -- --ignored
# ...（其余同名：e2e_resource_limits / e2e_security_isolation / e2e_support_package / e2e_container_pool / e2e_problem_limits / e2e_dual_container）
```

- 集成测试 `#[ignore]` + `NOJ_RUN_E2E=1` 守卫
- `#[serial_test::serial]` 序列化执行避免 Docker 资源竞争
- 30s 外层超时：`tokio::time::timeout(30s, ...)`
- CI 使用 `mozilla/sccache-action`（GHA cache backend）缓存编译产物；
  本地可 `cargo install sccache --locked` + `RUSTC_WRAPPER=sccache` 加速

### 12.3 跨模块 E2E（noj-tests）

```bash
cd noj-tests && deno task test
```

- `deno.json` task 已自动 `--env-file=../env.e2e.template`，**无需前缀 `NOJ_RUN_E2E=1`**
- 覆盖：Accepted / WrongAnswer / TLE / MQ 可靠性 / 无效消息容错 / 鉴权守卫 / S3 存储 / SSE / 私信 / 审计日志 / 重测 / 双容器等
- 辅助启动：`./run-e2e.sh`

---

## 13. CI/CD

### 13.1 GitHub Actions

**`ci.yml`** — PR/推送触发，并行检查三个模块（2026-07 起按模块路径过滤，
PR 只跑改动涉及的 job；`changes` job 用 `dorny/paths-filter` 检测）：

| Job | 检查项 | 依赖服务 |
|-----|--------|----------|
| changes | 路径过滤（PR 按 noj-core/ui/judge 改动集条件化后续 job） | 无 |
| core-quick-check | deno fmt + lint + typecheck | 无 |
| core-smoke | 冒烟测试（Hono /health） | Redis |
| core-test-unit | tests/lib + middleware + types + data + app（PGlite 内存库） | Redis |
| core-test-db | tests/services + routes + mq + db + 迁移/种子（真实 PG 覆盖 pg_trgm/GIN） | PostgreSQL + Redis |
| core-perf | tests/perf（NOJ_RUN_PERF=1，仅 main push / workflow_dispatch） | PostgreSQL + Redis |
| ui-check | deno lint, deno fmt, npm install, nuxt build | 无 |
| judge-check | cargo fmt + clippy + nextest（合并单 job 共享编译产物） | 无（sccache） |
| judge-e2e | Docker 沙箱 binary（分组并行） | Docker + Redis（sccache） |

**`e2e.yml`** — 全链路管道测试（PR/推送 main，2026-07 起拆为两个并行 job）：

- `e2e`：构建支持包 + 评测镜像 + Docker Compose，启动完整评测栈
  （noj-core + noj-judge + PG:5433 + Redis:6380），noj-tests E2E 文件
  分组并行
- `judge-sandbox`：noj-judge Docker 沙箱 E2E（只依赖 Docker + Redis，
  测试内自建镜像，与 API E2E 完全并行；binary 分组并行）
- 超时 60min，`always()` 输出诊断日志
- env：`JWT_SECRET=e2e-ci-secret-fixed-value-with-32-chars-min-abc`（≥32 字符，main.ts 强校验）
- PR `paths-ignore`：docs / noj-ui / 纯配置类改动不触发（noj-ui 不涉及评测栈）

---

## 14. 故障排查速查

| 现象 | 处理 |
|------|------|
| `JWT_SECRET 长度不足 32` | 在 `noj-core/.env` 设置 32+ 字符随机串（`openssl rand -base64 48`） |
| `DATABASE_URL` 连接拒绝 | `docker compose ps` 确认 PG 启动；端口 5432 未占用 |
| `zip: command not found` | `sudo apt install -y zip unzip` 或先跑 `devtool.sh install-deps` |
| `Cannot connect to Docker daemon` | 启动 Docker Desktop 或 `sudo systemctl start docker` |
| 端口 3000 / 8000 冲突 | `lsof -i :3000` 杀掉占用或修改 `PORT` |
| 提交后长时间 `Pending` | noj-judge 未启/未连 Redis；查 `scripts/dev/logs/judge.log`，或 `devtool.sh status judge` |
| 队列堆积 | `redis-cli LLEN noj:judge:queue`；重启 noj-judge 触发自动重连 |
| `noj-download://` 解码失败 | `deno task problems:build` 重建支持包 |
| `image not found` | 默认镜像 `noj-judge-python`；检查 `noj-judge/docker/` 构建脚本 |
| 迁移失败 | `cd noj-core && deno task db:migrate` 看脱敏日志 |
| 种子数据缺失 | 确认 `noj-core/.env` 已配 `ADMIN_EMAIL`；重新 `deno task dev-setup` |
| 想清空重置 | `docker compose down -v` 删卷后 `up -d` + `deno task dev-setup` |
| `deno task db:migrate` 不读 .env | deno.json task 已显式 `--env-file=.env`，正常应工作 |

日志位置：`scripts/dev/logs/{core,ui,judge}.log`；前端队列状态页：<http://localhost:3000/queue>。

工具异常排查：`RUST_LOG=noj_judge=debug` 调 judge 日志详细度；`devtool.sh status --json | python3 -m json.tool` 看结构化模块状态。

---

## 15. 参考文档

| 文档 | 路径 | 用途 |
|------|------|------|
| 用户 README | [`README.md`](./README.md) | 用户面向的项目说明 |
| noj-core 详细文档 | [`noj-core/CLAUDE.md`](./noj-core/CLAUDE.md) | Deno + Hono 后端完整约定 |
| noj-ui 详细文档 | [`noj-ui/CLAUDE.md`](./noj-ui/CLAUDE.md) | Nuxt + Vue 前端完整约定 |
| noj-judge 详细文档 | [`noj-judge/CLAUDE.md`](./noj-judge/CLAUDE.md) | Rust Worker 完整约定 |
| E2E 测试指南 | [`noj-tests/E2E_TESTING.md`](./noj-tests/E2E_TESTING.md) | 跨模块 E2E 测试方法 |
| 开发工具 devtool.sh | [`scripts/dev/devtool.sh`](./scripts/dev/devtool.sh) | 本地开发编排（install-deps / init-env / start / stop / status） |
| AI 入口（本文档） | [`AGENTS.md`](./AGENTS.md) | AI 编码助手项目知识库 |
| OpenSpec 主规范 | [`openspec/specs/`](./openspec/specs/) | 行为规范（Requirements + Scenarios） |
| Superpowers 设计稿 | [`docs/superpowers/specs/`](./docs/superpowers/specs/) | 大型变更的设计文档（Context / Decisions / Risks），与 `openspec/specs/` 行为规范**分开** |
| Superpowers 实施计划 | [`docs/superpowers/plans/`](./docs/superpowers/plans/) | 已批准设计的逐步实施计划（Task 拆分） |

---

*本文档为顶层 AI 入口。各模块详细约定、API 端点、Schema 字段、组件层级请参考对应子目录 `CLAUDE.md`。*