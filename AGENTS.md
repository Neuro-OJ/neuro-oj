# Neuro OJ (NOJ) — 完整项目知识库

Neuro OJ 是一个为 LMCC（CCF 大语言模型能力认证）设计的在线评测（Online Judge）系统。

> **注意：** Neuro OJ 与 CCF 及 LMCC 无任何官方关系，为独立社区项目。

---

## 目录

1. [架构总览](#1-架构总览)
2. [目录结构](#2-目录结构)
3. [技术栈](#3-技术栈)
4. [基础设施与启动](#4-基础设施与启动)
5. [版本控制约定](#5-版本控制约定)
6. [贡献流程](#6-贡献流程)
7. [安全模型总览](#7-安全模型总览)
8. [测试体系](#8-测试体系)
9. [CI/CD](#9-cicd)
10. [OpenSpec 开发工作流](#10-openspec-开发工作流)
11. [项目状态与路线图](#11-项目状态与路线图)

---

## 1. 架构总览

NOJ 分为三个核心模块，通过 RESTful API 和 Redis 消息队列协作：

```
+----------+   RESTful API   +----------+   Redis MQ    +--------------+
|  noj-ui  | <-------------> | noj-core | --Producer--> |  noj-judge   |
|  Nuxt.js  |                 |Deno+Hono | <--Consumer--|  Rust+Docker |
+----------+                 +----------+               +--------------+
                                   |
                              +----+----+
                              |  Redis   |
                              +---------+
```

### 消息流

1. 用户通过 noj-ui 提交代码
2. noj-core 接收请求，将评测任务发布到 Redis MQ（LPUSH `noj:judge:queue`）
3. noj-judge 从 MQ 拉取任务（BRPOP `noj:judge:queue`）
4. noj-judge 在 Docker 容器中执行评测
5. 结果通过 Redis MQ 返回（LPUSH `noj:judge:results`）
6. noj-core 消费结果（BRPOP `noj:judge:results`），持久化到数据库

架构遵循 **Producer-Consumer** 模式，支持多个 noj-judge 实例水平扩展。

### 提交流程详解

用户提交代码后，noj-core 组装 JudgeTask 消息推送到 Redis MQ：

```json
{
  "submission_id": "uuid",
  "problem_id": "1001",
  "judge_image": "noj-judge-python",
  "judge_command": "python3 /tmp/evaluate.py",
  "support_package_path": "data/packages/1001.zip",
  "language": "python3",
  "code": "...",
  "file_name": "submission.py",
  "time_limit_ms": 5000,
  "memory_limit_mb": 512
}
```

noj-judge 收到任务后执行：

1. **加载支持包** -- 读取 support_package_path 指向的 zip（含 evaluate.py、测试用例等）
2. **注入用户代码** -- 将 code 以 file_name 命名写入工作目录（覆盖/补全支持包文件）
3. **执行评测** -- 在 Docker 容器中运行 judge_command（evaluate.py 负责读取测试用例并评分）
4. **返回结果** -- 将 stdout/stderr、得分、耗时、内存等打包为 JudgeResult 发回 Redis MQ

支持包（zip）由 `deno task build-packages` 从 `data/problems-src/<id>/` 构建。
用户提交的代码（如 `submission.py`）**不**包含在支持包中 -- 由 noj-judge 在运行时放入。

---

## 2. 目录结构

```
neuro-oj/
├── noj-core/             # 核心后端 (Deno + Hono)
│   ├── deno.json         # 项目配置 + 导入映射
│   ├── deno.lock         # 依赖锁定（提交到 git，用于 CI 缓存）
│   ├── drizzle.config.ts # Drizzle Kit 配置
│   ├── drizzle/          # SQL 迁移文件（自动生成，勿手动编辑 _journal.json）
│   │   ├── meta/_journal.json
│   │   └── 0000_*.sql    # 通过 0005 共 6 个迁移文件
│   ├── .env.example      # 环境变量模板（不提交 .env）
│   ├── src/
│   │   ├── main.ts       # 入口（启动校验 + 初始化顺序）
│   │   ├── app.ts        # Hono 应用工厂（CORS + 路由 + 错误处理）
│   │   ├── mod.ts        # 公共导出
│   │   ├── routes/       # 路由层（参数校验 + 调用 service）
│   │   │   ├── auth.ts, categories.ts, health.ts
│   │   │   ├── problems.ts, queue.ts
│   │   │   ├── submissions.ts, users.ts
│   │   ├── services/     # 业务逻辑层（数据库读写）
│   │   │   ├── auth.ts, categories.ts, problems.ts
│   │   │   ├── queue.ts, submissions.ts, users.ts
│   │   ├── db/
│   │   │   ├── connection.ts  # 数据库连接管理（单例模式）
│   │   │   ├── migrate.ts     # 迁移执行器（绝对路径解析，不依赖 CWD）
│   │   │   └── schema.ts      # Drizzle 表定义（6 张表）
│   │   ├── middleware/
│   │   │   └── auth.ts        # JWT 认证中间件
│   │   ├── mq/
│   │   │   ├── connection.ts  # Redis 连接管理（shared + consumer 双连接）
│   │   │   ├── consumer.ts    # 评测结果消费者（BRPOP 阻塞）
│   │   │   └── producer.ts    # 评测任务生产者（LPUSH）
│   │   ├── lib/
│   │   │   ├── errors.ts      # AppError 继承体系（6 个子类）
│   │   │   ├── jwt.ts         # JWT 签发/验证（HS256, iss/aud 校验）
│   │   │   ├── password.ts    # bcrypt 哈希/比对（cost 12）
│   │   │   ├── request.ts     # parseJsonBody<T>() 安全 JSON 解析
│   │   │   └── logging.ts     # 生产安全日志（UUID 截断、分值隐藏）
│   │   └── types/
│   │       ├── index.ts       # JudgeTask, JudgeResult, SubmissionStatus
│   │       ├── auth.ts        # RegisterInput, LoginInput, UserResponse
│   │       └── problems.ts    # CreateProblemInput, DIFFICULTIES, PROBLEM_TYPES
│   ├── scripts/
│   │   ├── seed.ts            # 数据库种子（幂等，ON CONFLICT DO NOTHING）
│   │   ├── build-packages.ts  # 构建支持包 zip（调用系统 zip 命令）
│   │   └── migrate.ts         # 迁移脚本（日志中脱敏数据库密码）
│   ├── data/
│   │   ├── problems-src/      # 题目源文件（仅样例题，版本控制）
│   │   │   ├── 1001/          # "星港舱门报码归一化" (easy)
│   │   │   ├── 1002/          # "传感器数据滤波" (medium, 无支持包)
│   │   │   └── 1003/          # "A+B Problem" (easy)
│   │   └── packages/          # 构建产物 (gitignored)
│   └── tests/                 # 测试文件（与 src 镜像结构）
│       ├── 00_migrate_test.ts # 最先执行：迁移 + seed root 用户
│       ├── services/          # 服务层测试（auth, problems, submissions 等）
│       ├── routes/            # 路由层测试（使用 jsonRequest() 辅助函数）
│       └── lib/               # 工具函数测试
│
├── noj-ui/               # 前端界面 (Nuxt 4 + Vue 3)
│   ├── deno.json         # 任务定义 + npm 兼容配置
│   ├── package.json      # @noj/ui v0.1.0
│   ├── nuxt.config.ts    # Nuxt 配置（vite, nitro preset, runtimeConfig）
│   ├── tailwind.config.ts # Tailwind 主题扩展（含 prose-neuro 排版插件）
│   ├── app.vue           # 根组件 + CSS 变量定义
│   ├── pages/            # 文件路由（Nuxt 自动路由）
│   │   ├── index.vue           # 首页（Hero + 动画背景）
│   │   ├── login.vue           # 登录（3s 自动消失错误提示）
│   │   ├── register.vue        # 注册（复杂密码校验 + 自动登录）
│   │   ├── problems.vue        # 题目列表（URL 驱动筛选）
│   │   ├── problems/[id].vue   # 题目详情 + Monaco 代码提交
│   │   ├── problems/new.vue    # 创建题目（ssr: false）
│   │   ├── problems/[id]/edit.vue # 编辑题目（ssr: false）
│   │   ├── submissions/        # 提交历史（筛选/状态标签/分页）
│   │   ├── submissions/[id].vue # 提交详情（1.5s 轮询+高亮代码）
│   │   ├── queue.vue           # 队列状态（2s 轮询）
│   │   ├── about.vue, settings.vue
│   │   ├── users/[id].vue      # 用户主页
│   │   ├── my/problems.vue     # 我的题目（U 型）
│   │   └── admin/              # 管理后台（ssr: false）
│   │       ├── index.vue, users.vue, problems.vue
│   │       ├── categories.vue, submissions.vue
│   │       ├── problem-new.vue, problem-edit/[id].vue
│   ├── components/
│   │   ├── Navbar.vue          # 固定顶栏 + 用户菜单
│   │   ├── FooterBar.vue       # 深色底栏
│   │   ├── Sidebar.vue         # 折叠侧栏（15px/200px）
│   │   ├── MarkdownRenderer.vue # Markdown + KaTeX + DOMPurify
│   │   ├── MonacoEditor.vue    # CDN 加载 Monaco Editor
│   │   ├── ProblemEditor.vue   # 题目编辑器（创建/编辑双模式）
│   │   ├── ProblemFilterBar.vue # 搜索 + 类型 + 难度 + 分类
│   │   ├── ProblemId.vue       # 彩色题号（U=蓝, P=紫）
│   │   ├── StatusBadge.vue     # 解决状态标签
│   │   ├── PaginationNav.vue   # 智能分页
│   │   ├── ui/AsyncContent.vue # 异步内容容器（loading/error/empty/data）
│   │   ├── ui/BaseButton.vue   # 智能按钮（NuxtLink/a/button）
│   │   ├── admin/AdminTable.vue # 通用管理表格
│   │   └── admin/AdminModal.vue # 确认弹窗
│   ├── composables/
│   │   ├── useAuth.ts          # 认证状态管理（useState + Cookie）
│   │   ├── usePolling.ts       # setInterval 轮询 + 竞态保护
│   │   ├── useToast.ts         # SweetAlert2 Toast
│   │   ├── useDialog.ts        # SweetAlert2 弹窗
│   │   ├── useProblemFilters.ts # URL 驱动筛选
│   │   └── use-submissions.ts  # 提交数据/格式函数
│   ├── layouts/
│   │   ├── default.vue         # 默认布局（Navbar + Footer）
│   │   ├── auth.vue            # 认证布局（登录/注册）
│   │   └── admin.vue           # 管理布局（侧栏 + 顶栏）
│   ├── server/
│   │   ├── api/[...slug].ts    # Nitro 代理（拦截登录 + JWT Cookie 注入）
│   │   └── api/auth/logout.post.ts # 本地注销（清除 Cookie）
│   ├── middleware/             # Nuxt 路由守卫
│   │   ├── auth.ts             # 登录守卫（5s 超时）
│   │   └── admin.ts            # 管理员守卫（静默重定向）
│   ├── utils/sanitize.ts       # HTML 清洗（DOMPurify 异步加载）
│   └── assets/                 # 静态资源（logo.jpg 等）
│
├── noj-judge/             # 评测 Worker (Rust + Docker)
│   ├── Cargo.toml         # 依赖：tokio, bollard, redis-rs, axum
│   ├── Cargo.lock         # 版本锁定（提交到 git）
│   ├── .dockerignore      # 排除 target/ tests/ docker/（800MB -> 200KB）
│   ├── Dockerfile.e2e     # E2E 测试用多阶段构建
│   ├── docker/
│   │   └── python/Dockerfile  # 评测运行时（python:3.12-slim）
│   ├── src/
│   │   ├── main.rs        # 入口（双模式：Pool / Semaphore）
│   │   ├── lib.rs          # 库入口（暴露模块给集成测试）
│   │   ├── config.rs       # 环境变量配置（PoolConfig + 全局配置）
│   │   ├── types.rs        # JudgeTask, JudgeResult, CaseResult
│   │   ├── mq.rs           # Redis MQ 拉取/推送（重试 + fallback 文件）
│   │   ├── sandbox/
│   │   │   ├── mod.rs
│   │   │   └── container.rs # 容器生命周期 + zip 解压 + 命令解析
│   │   ├── judge/
│   │   │   ├── mod.rs
│   │   │   └── runner.rs    # 评测逻辑（---RESULT--- 解析 + 超时/OOM 检测）
│   │   └── pool/
│   │       ├── mod.rs       # PoolManager（容器池 + RAII Guard + 健康检查）
│   │       ├── copy.rs      # tar 打包 + docker exec 注入文件
│   │       ├── exec.rs      # docker exec + cgroup 内存峰值读取
│   │       ├── metrics.rs   # Prometheus /metrics HTTP 端点
│   │       └── scaler.rs    # 自动扩缩容（滑动窗口 QPS + 排队时间）
│   └── tests/
│       ├── common/mod.rs    # 测试公共辅助函数
│       ├── e2e/
│       │   ├── Dockerfile.test-runner  # 测试用 Python 镜像
│       │   └── evaluate.py  # 测试用评测脚本（--hang/--memory-test 等标志）
│       ├── e2e_docker_basic.rs
│       ├── e2e_resource_limits.rs
│       ├── e2e_security_isolation.rs
│       ├── e2e_support_package.rs
│       ├── e2e_container_pool.rs
│       └── e2e_problem_limits.rs
│
├── noj-tests/             # 跨模块全链路 E2E 测试
│   ├── deno.json
│   ├── E2E_TESTING.md
│   ├── run-e2e.sh
│   └── e2e/
│       ├── helper.ts
│       ├── 01_categories.test.ts
│       ├── 02_problems.test.ts
│       ├── 03_auth.test.ts
│       ├── 04_submissions.test.ts
│       ├── 05_profile.test.ts
│       ├── 06_pipeline.test.ts
│       └── 07_queue.test.ts
│
├── openspec/              # OpenSpec 规范驱动开发
│   ├── config.yaml
│   ├── specs/             # 主规范（26 个）
│   └── changes/           # 变更提案
│       ├── u-p-problem-bank-split/  # 活跃变更（当前开发中）
│       └── archive/       # 已归档变更（16 个）
│
├── scripts/               # 构建与维护脚本
│   ├── build-packages.sh
│   ├── migrate.sh, seed.sh
│   └── e2e/               # E2E 编排脚本
│       ├── setup.sh, teardown.sh, run-all.sh
│       ├── core.sh, judge.sh
│
├── .github/workflows/
│   ├── ci.yml             # PR/推送: 并行检查三个模块
│   └── e2e.yml            # 全链路管道 E2E（15min/5-8min 缓存命中）
│
├── docker-compose.yml     # 开发基础设施（PG:5432 + Redis:6379）
├── docker-compose.e2e.yml # E2E 测试编排（含 noj-core + noj-judge）
├── env.e2e.template       # E2E 测试环境变量模板
├── .gitignore
├── AGENTS.md              # 本文档
├── CLAUDE.md -> AGENTS.md # AI 编码助手入口
├── LICENSE                # AGPL-3.0
├── README.md              # 项目 README
├── ROADMAP.md             # 开发路线图
├── skills-lock.json       # Claude Code 技能锁定
└── .opencode/             # OpenSpec 技能配置（与 .claude/ 镜像结构）

---

## 3. 技术栈

| 模块      | 语言/运行时          | 核心框架       | 关键依赖               |
| --------- | -------------------- | -------------- | ---------------------- |
| noj-core  | Deno / TypeScript    | Hono           | Drizzle ORM, ioredis, Jose (JWT), postgres.js, bcryptjs |
| noj-ui    | Deno / TypeScript | Nuxt 4 / Vue 3 | Tailwind CSS, Monaco Editor, Lucide Icons, SweetAlert2, markdown-it, KaTeX, highlight.js, DOMPurify |
| noj-judge | Rust (Edition 2021)  | Tokio          | bollard (Docker API), redis-rs, serde, axum (metrics), zip, tar |
| 基础设施  | PostgreSQL 16 + Redis 7 | docker-compose | Drizzle Kit (迁移) |

### 关键依赖版本

**noj-core** (deno.lock)：hono@^4, drizzle-orm@0.45.2, postgres@3.4.5, ioredis@5.11.1, bcryptjs@^2.4.3, jose@^5, jsr:@std/encoding@^1

**noj-ui** (package.json)：nuxt@^4.0.0, vue@latest, tailwindcss, @nuxtjs/tailwindcss, @tailwindcss/typography, monaco-editor, sweetalert2, markdown-it, katex, highlight.js, dompurify, @lucide/vue

**noj-judge** (Cargo.toml)：redis@0.27 (tokio-comp), tokio@1 (full), bollard@0.21, serde@1, serde_json@1, anyhow@1, tracing@0.1, uuid@1 (v4), base64@0.22, zip@2 (deflate), tar@0.4, axum@0.8

---

## 4. 基础设施与启动

### Docker Compose 开发环境

```bash
docker compose up -d    # 启动 PostgreSQL:5432 + Redis:6379
docker compose down     # 停止
```

| 服务 | 镜像 | 端口 | 默认凭据 |
|------|------|------|----------|
| PostgreSQL | postgres:16-alpine | 5432 | noj / noj / 数据库 noj |
| Redis | redis:7-alpine | 6379 | 无认证 |

数据卷持久化：redis-data、postgres-data（docker compose down 不丢失）。

### 启动顺序

**noj-core 启动顺序**（main.ts 严格遵循以下步骤）：

1. **JWT_SECRET 强度校验** -- HS256 要求 >= 32 字符，不足则 Deno.exit(1) 拒绝启动
2. **数据库迁移** -- 失败为致命错误，终止启动
3. **确保 root 系统用户存在** -- UID=0，admin 角色，随机密码不可登录
4. **连接 Redis** -- 失败则 degraded 模式（HTTP 仍启动，评测功能不可用）
5. **启动评测结果消费者** -- 后台自动重连（指数退避 1s -> 2s -> 4s -> ... -> 30s）
6. **启动 HTTP 服务** -- Deno.serve({ port }, app.fetch)

**noj-judge 启动顺序**（main.rs）：

1. 创建 Tokio 运行时
2. 初始化 tracing 日志
3. 从环境变量加载配置
4. 连接 Redis + PING 验证
5. 连接 Docker + PING 验证
6. 根据模式：PoolManager::init（启动后台任务 -> 事件循环）或 Semaphore 循环
7. ctrl_c() 信号处理（SIGINT）触发优雅关闭

### 快速启动

```bash
# 启动基础设施
docker compose up -d

# 启动 noj-core
cd noj-core
deno task setup          # build-packages + seed
deno task dev            # 热重载

# 启动 noj-ui
cd noj-ui
npm install
deno task dev            # 默认 http://localhost:3000

# 启动 noj-judge
cd noj-judge
cargo run               # 需要 Docker daemon

# 三模块可独立启动，开发时可以只跑需要的部分
```

### 创建第一个管理员

首次运行 `deno task setup` 后，若未设置 `ADMIN_EMAIL`/`ADMIN_PASS` 环境变量，seed 脚本会自动创建引导管理员（仅限无任何可登录 admin 时）：

```bash
cd noj-core && deno task setup
# 终端输出类似：
# ⚠ 已创建临时引导管理员（首次登录后必须修改密码）
#   username: admin
#   email:    admin@noj.local
#   password: <24字符 base64url 随机>
```

引导管理员登录后**必须**立即修改密码，否则无法访问受保护页面（自动强制跳转 `/change-password`）。

**推荐做法**：在 `.env` 中设置 `ADMIN_EMAIL` 和 `ADMIN_PASS`，运行 seed 后直接使用固定凭据登录：

```bash
echo 'ADMIN_EMAIL=admin@example.com' >> noj-core/.env
echo 'ADMIN_PASS=YourSecurePass123!' >> noj-core/.env
cd noj-core && deno task seed
```

详见 [issue #75](https://github.com/Neuro-OJ/neuro-oj/issues/75)。

---

## 5. 版本控制约定

### 使用 Jujutsu (jj)

本机使用 **jj**（Jujutsu）管理本地仓库，推送到远程使用 `jj git push`。

- 无需暂存区：直接 `jj describe` 设置提交信息，`jj new` 创建新提交
- 误操作使用 `jj undo` 回退
- 推送到远程使用 `jj git push`

### 提交信息规范

遵循 Conventional Commits 规范：

- 格式：`<type>(<scope>): <description>`
- type：`feat` `fix` `docs` `style` `refactor` `perf` `test` `chore` `ci` `build`
- scope 可选：`core` `ui` `judge` `root`
- description 使用**中文**
- 示例：`feat(core): 添加评测任务分发 API` / `fix(judge): 修复容器超时未清理`

### 项目语言

项目主要语言为**中文**。以下必须使用中文：
- 提交信息（type 保留英文，description 使用中文）
- 代码注释
- 文档（README、AGENTS.md 等）
- PR 描述和 Issue
- 例外：代码标识符（变量名、函数名）使用英文

### GPG 签名要求（强制）

所有提交必须使用 GPG 密钥签名。详见 README.md 中的必要性说明。

---

## 6. 贡献流程

**所有代码必须以 Pull Request 形式提交，禁止直接推送到 main 分支。**

**所有提交必须使用 GPG 密钥签名。**

### Agent 职责

AI 编码助手在修改代码前必须检查 GPG 配置：

```bash
gpg --list-secret-keys --keyid-format LONG
git config --global user.signingkey
git config --global commit.gpgsign
jj config get signing.key 2>/dev/null
```

未配置签名时，说明必要性后引导用户完成配置。不得在签名就绪前提交代码。

### PR 工作流

```bash
# 1. 创建分支（使用 jj）
jj new main
jj describe

# 2. 推送分支
jj git push -b <branch-name>

# 3. 创建 PR
gh pr create --draft      # Draft PR
gh pr create --fill       # 直接创建

# 4. 迭代修复
jj new
jj squash
jj git push -b <branch-name> --force

# 5. 合并后同步
jj git fetch
jj new main
jj git push
```

### 子模块文档

各子模块有独立的 AGENTS.md/CLAUDE.md：

- `noj-core/CLAUDE.md` -- Deno + Hono 后端完整约定
- `noj-ui/CLAUDE.md` -- Nuxt + Vue 前端完整约定
- `noj-judge/CLAUDE.md` -- Rust Worker 完整约定

在特定模块目录下工作时会优先加载，提供更精准的上下文。


---

## 7. 安全模型总览

### 认证

- JWT HS256，iss/aud 校验（iss=nj-core, aud=nj-ui）
- HTTP-only Cookie（noj:token），JS 不可见，防 XSS 窃取
- 无刷新令牌机制（JWT 过期需重新登录）
- 无 JWT 撤销机制（jti 已生成但未持久化校验）
- 24h 过期（JWT_EXPIRES_IN 可配置）
- 登录时设置两个 Cookie：noj:token（HTTP-only）+ noj:session（可读，仅用于 UI 快速判断）

### 密码安全

- bcrypt cost 12（约 250-300ms 单次哈希，OWASP 2025+ 最低建议）
- 最小长度 12 字符，含大小写字母+数字
- 不能与用户名/邮箱前缀相同

### 防枚举

- 登录失败统一返回"用户名或密码错误"，不区分用户是否存在
- 无速率限制 / IP 封禁 / CAPTCHA（已知限制）

### 容器安全（noj-judge）

- cap_drop ALL -- 移除所有 Linux 能力
- no-new-privileges -- 禁止子进程获得更高权限
- network_mode none -- 完全隔离网络
- ipc_mode none -- 禁止 IPC 命名空间共享
- pids_limit 256 -- 限制进程数
- tmpfs /tmp (256M) -- 临时文件系统

### ZIP 安全（硬编码不可配置）

- 路径穿越防护：拒绝含 .. 或 / 开头的条目
- 炸弹防护：1000 条目 / 64MB 单文件 / 512MB 总解压

### XSS 防护

- HTTP-only Cookie（JWT 对 JS 不可见）
- DOMPurify 清洗 Markdown 渲染

### CSRF

- Cookie sameSite: 'lax' 提供基础防护
- 无 CSRF token（已知限制）

### 授权

- 服务端强制校验角色（UI session cookie 仅用于展示）
- admin 可创建任意 type，普通用户仅限 U 型
- P 型仅 admin 可 CRUD，U 型 owner/admin 可 CRUD
- 禁止降级最后一个可登录 admin
- root 用户（UID=0）不计入管理员统计

### CORS

- 开发环境：Access-Control-Allow-Origin: *
- 生产环境：仅白名单域名
- credentials: true, maxAge: 86400

### 日志安全（NOJ_ENV=production）

- submission_id 截断至前 8 字符
- score 在日志中隐藏
- 数据库密码在迁移脚本中脱敏

### 已知限制（设计决策）

- 无刷新令牌机制
- 无 JWT 撤销机制（jti 未持久化）
- 无速率限制 / IP 封禁 / CAPTCHA
- 无 CSRF token（依赖 sameSite: 'lax'）
- 注册存在 TOCTOU 竞争条件（DB 唯一约束为最终保障）

---

## 8. 测试体系

### noj-core 测试（Deno，~19 个测试文件）

```bash
cd noj-core && deno task test
```

- DB 依赖测试检查 DATABASE_URL/JWT_SECRET，缺失时静默跳过
- sanitizeResources: false, sanitizeOps: false
- 路由测试使用 jsonRequest() 辅助函数
- 测试数据使用 Date.now() 生成唯一用户名/邮箱

### noj-judge 测试（Rust）

**单元测试**（无需 Docker）：
```bash
cd noj-judge && cargo test --lib
```

**Docker 沙箱 E2E 测试**：
```bash
NOJ_RUN_E2E=1 cargo test --test e2e_docker_basic -- --ignored
```

- 集成测试使用 #[ignore] + NOJ_RUN_E2E=1 守卫
- #[serial_test::serial] 序列化执行，避免 Docker 资源竞争
- 30 秒外层超时：tokio::time::timeout(30s, ...)

### 跨模块全链路 E2E 测试（noj-tests）

```bash
cd noj-tests
NOJ_RUN_E2E=1 deno task test:e2e
```

覆盖场景：Accepted / WrongAnswer / TLE / MQ 可靠性 / 无效消息容错

---

## 9. CI/CD

### GitHub Actions

**ci.yml** -- 每个 PR/推送触发，并行检查三个模块：

| Job | 检查项 | 需要服务 |
|-----|--------|----------|
| core-test | deno fmt, deno lint, deno test | PostgreSQL + Redis |
| ui-check | npm install, nuxt build | 无 |
| judge-check | cargo fmt, clippy, build, test | 无 |
| judge-e2e | cargo test --ignored | Docker（手动触发） |

**e2e.yml** -- 全链路管道测试，PR/推送 main 时运行：
- 构建支持包 + 评测镜像 + Docker Compose
- 启动完整评测栈（noj-core + noj-judge + PG + Redis）
- 运行 noj-tests E2E（52 个测试）
- 运行 noj-judge Docker 沙箱 E2E（12 个测试）
- 首次 ~15min，缓存命中后 ~5-8min
- 超时 60min，always() 输出诊断日志

---

## 10. OpenSpec 开发工作流

本项目使用 OpenSpec 进行规范驱动开发。

### 目录结构

```
openspec/
├── config.yaml          # OpenSpec 配置
├── specs/               # 主规范（26 个活跃 spec）
│   ├── database-schema/ # 数据库 Schema
│   ├── user-auth/       # 用户认证
│   ├── problem-*/       # 题目管理相关
│   ├── judge-*/         # 评测相关
│   ├── admin-*/         # 管理后台
│   ├── container-pool/  # 容器池
│   └── ...
└── changes/             # 变更提案
    ├── u-p-problem-bank-split/  # 活跃变更
    └── archive/         # 16 个已归档变更
```

### 开发历史（按时间线）

1. 2026-06-20: infra-database-redis-mq + user-auth + noj-judge-basic + problems-submissions-api
2. 2026-06-21: admin-crud + submission-list-api + user-profile-api
3. 2026-06-22: container-pool + resource-metrics + migrate-to-tailwind + user-profile-bio
4. 2026-06-23: judge-queue-visibility
5. 2026-06-24: e2e-tests + ui-problem-list + migrate-to-cookies
6. 2026-06-25: admin-panel-frontend + submission-history
7. 2026-06-26: u-p-problem-bank-split（当前活跃）

---

## 11. 项目状态与路线图

当前处于 **Phase 1（MVP）** 阶段

| 阶段 | 交付标准 |
|------|----------|
| Phase 0 | 浏览器注册 -> 做题 -> 提交 -> 看到评测结果 |
| Phase 1 | 榜单可查，题目可筛选，管理后台可用 |
| Phase 2 | 可创建比赛 -> 用户参赛 -> 实时榜单 -> 赛后复盘 |
| Phase 3 | 多 Worker 并发评测，99.5% 可用性 |

### 已知遗留问题

**noj-judge Scaler 已知 Bug**（来自 scaler-review-output.json）：
1. 事件到达时间戳压缩：arrival 时间戳在批处理消费时使用 Instant::now()，QPS 计算失真
2. QPS 分母与窗口不匹配：分母使用 1x interval，裁剪窗口 1.5x，QPS 被高估 50%
3. sample_count 永不重置：miss_rate 分母永不清零，扩容触发条件永远不满足

**前端已知限制**：
- 无单元测试 / E2E 测试
- 无 SEO 优化（无 OG 标签、sitemap）
- 无图片优化（仅 logo.jpg）
- 无 web fonts（使用系统字体栈）
- 无单独 types/ 目录（类型在组件内或 composables 中）
- Composable 命名不一致：camelCase（useAuth）vs kebab-case（use-submissions）

---

## 参考文档

- [noj-core 详细文档](noj-core/CLAUDE.md)
- [noj-ui 详细文档](noj-ui/CLAUDE.md)
- [noj-judge 详细文档](noj-judge/CLAUDE.md)
- [E2E 测试指南](noj-tests/E2E_TESTING.md)
- [开发路线图](ROADMAP.md)
- [项目 README](README.md)

---

*本文档为顶层概要。各模块的详细开发约定、API 文档、环境变量、源代码结构请参考对应子目录的 CLAUDE.md。*
