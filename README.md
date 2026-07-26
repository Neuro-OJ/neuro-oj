# NOJ · Neuro OJ

**面向大模型能力评测场景的在线评测系统**

[![Deno](https://img.shields.io/badge/Deno-2.x-000?logo=deno&logoColor=fff)](https://deno.com)
[![Rust](https://img.shields.io/badge/Rust-2021-dea584?logo=rust&logoColor=000)](https://rust-lang.org)
[![Nuxt 4](https://img.shields.io/badge/Nuxt_4-00DC82?logo=nuxt&logoColor=fff)](https://nuxt.com)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=fff)](https://postgresql.org)
[![Redis](https://img.shields.io/badge/Redis-7-FF4438?logo=redis&logoColor=fff)](https://redis.io)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue)](./LICENSE)
[![CI](https://github.com/Neuro-OJ/neuro-oj/actions/workflows/ci.yml/badge.svg)](https://github.com/Neuro-OJ/neuro-oj/actions/workflows/ci.yml)

> Neuro OJ 为独立社区项目，与 CCF（中国计算机学会）及 LMCC（大模型能力认证）无任何官方关系。

---

## 什么是 Neuro OJ？

Neuro OJ（NOJ）是一个面向**大模型实操能力评测**场景的在线评测系统。与传统算法竞赛 OJ 不同，NOJ 评测的是指令微调、提示工程、Agent 构建、模型对齐等编程任务——这些任务需要灵活的评测逻辑、严格的资源隔离和可水平扩展的 Worker 架构。

### 典型场景

- **教学实训** — 大模型课程中的编程作业自动评测
- **能力认证** — 复现类似 LMCC 第二轮编程题的机考环境
- **模型评测** — 自动化评估模型在特定任务上的代码能力

---

## 系统架构

NOJ 由三个模块通过 RESTful API 和 Redis 消息队列协作：

```
+----------+   RESTful API   +----------+   Redis MQ    +--------------+
|  noj-ui  | <-------------> | noj-core | --Producer--> |  noj-judge   |
|  Nuxt 4  |                 | Deno+Hono| <--Consumer--|  Rust+Docker  |
+----------+                 +----------+               +--------------+
                                   |
                              +----+----+
                              |  Redis   |
                              +---------+
```

- **noj-ui**（Nuxt 4 + Vue 3）— Web 前端，提供题目列表、代码编辑器、提交结果页、管理后台等。
- **noj-core**（Deno + Hono）— RESTful API 服务，负责用户/题目/提交/榜单等业务，并作为 Redis MQ 的生产者与消费者。
- **noj-judge**（Rust + Tokio）— 评测 Worker，从 MQ 拉取任务，在 Docker 沙箱中执行评测脚本并回传结果。
- **PostgreSQL 16** — 持久化存储；**Redis 7** — 消息队列与缓存。

### 评测消息流

1. 用户在 noj-ui 提交代码
2. noj-core 接收请求，将评测任务发布到 Redis 队列（`noj:judge:queue`）
3. noj-judge 从队列拉取任务
4. Worker 在 Docker 容器中执行评测脚本（资源隔离、网络关闭）
5. 结果回写 Redis（`noj:judge:results`）
6. noj-core 消费结果并持久化到数据库

---

## 环境要求

| 组件 | 版本 / 说明 |
|------|------------|
| 操作系统 | Linux / macOS（推荐 Ubuntu 22.04+） |
| [Deno](https://deno.com) | 2.x（运行 noj-core 与 noj-ui） |
| [Rust](https://www.rust-lang.org/) | toolchain stable（编译 noj-judge） |
| [Docker](https://www.docker.com/) | 20.10+，含 Docker Compose v2 |
| zip / unzip | 系统命令行工具（构建支持包依赖，`devtool.sh install-deps` 会自动安装） |
| Git | 2.x |
| 内存 | ≥ 4 GB（运行全部模块 + Postgres + Redis） |
| 端口 | 3000（前端）/ 8000（后端）/ 5432（PG）/ 6379（Redis） |

> 一键检测脚本：`bash scripts/dev/devtool.sh install-deps`，会自动安装 zip/unzip，并对其他依赖给出安装指引。

---

## 快速开始

### 方式 A：一键脚本（推荐）

适合本地日常开发。`scripts/dev/devtool.sh` 单文件编排工具，统一管理后台进程、PID 与日志到 `scripts/dev/logs/`。

```bash
# 1. 检测环境（自动安装 zip/unzip，提示其他依赖）
bash scripts/dev/devtool.sh install-deps

# 2. 准备环境变量（必填 DATABASE_URL 与 JWT_SECRET，至少 32 字符）
bash scripts/dev/devtool.sh init-env          # 默认拒绝覆盖，--merge 仅追加模板缺失键
$EDITOR noj-core/.env

# 3. 一键启动整套环境（infra → core → ui → judge）
bash scripts/dev/devtool.sh start             # 单模块：start ui / start core / start judge

# 4. 查看状态
bash scripts/dev/devtool.sh status            # 人类可读；--json 输出结构化

# 5. 停止全部模块
bash scripts/dev/devtool.sh stop              # 反向顺序：judge → ui → core → infra
```

详细子命令用法：`bash scripts/dev/devtool.sh help` 或 `devtool.sh <子命令> --help`。

启动完成后：

- 前端：<http://localhost:3000>
- 后端 API：<http://localhost:8000>
- 健康检查：`curl http://localhost:8000/health`

### 方式 B：手动分步启动

需要单独调试某个模块时使用前台运行，实时查看日志。

```bash
# 1. 基础设施
docker compose up -d          # PostgreSQL + Redis

# 2. 后端 noj-core
cd noj-core
deno task setup               # 构建支持包 + 填充种子数据
deno task dev                 # 热重载 http://localhost:8000

# 3. 前端 noj-ui（新开终端）
cd ../noj-ui
deno task dev                 # http://localhost:3000（首次运行会自动拉取依赖）

# 4. 评测 Worker noj-judge（新开终端）
cd ../noj-judge
cargo run                     # 需 Docker daemon 运行中
```

三模块相互独立，可只启动需要的部分（如只调试前端时无需启动 noj-judge）。

### 首个管理员账号

`deno task seed` 的行为依赖 `ADMIN_EMAIL` 是否设置：

- **未设置 `ADMIN_EMAIL`** — 自动创建引导管理员（密码 24 位随机写入终端输出，**首次登录后必须修改**）。
- **设置了 `ADMIN_EMAIL` 但未设置 `ADMIN_PASS`** — 仅提升该邮箱用户为管理员，不创建新用户。
- **同时设置 `ADMIN_EMAIL` 和 `ADMIN_PASS`** — 用户不存在时自动创建并设为 admin。

推荐做法——把凭据写进 `noj-core/.env` 后再运行 seed：

```bash
echo 'ADMIN_EMAIL=admin@example.com' >> noj-core/.env
echo 'ADMIN_PASS=YourSecurePass123!' >> noj-core/.env
cd noj-core && deno task seed
```

---

## 故障排查

### 启动相关

| 现象 | 可能原因 / 处理 |
|------|----------------|
| `JWT_SECRET 长度不足 32` | 在 `noj-core/.env` 设置 32+ 字符的随机字符串 |
| `DATABASE_URL` 报错 / 连接拒绝 | 确认 `docker compose ps` 中 Postgres 已启动；端口 5432 未被占用 |
| `deno task setup` 卡在 `zip: command not found` | `sudo apt install -y zip unzip` 后重试（或先跑 `devtool.sh install-deps`） |
| `cargo run` 报 `Cannot connect to Docker daemon` | 启动 Docker Desktop，或 `sudo systemctl start docker` |
| 端口 3000 / 8000 冲突 | 修改对应模块配置，或先 `lsof -i :3000` 杀掉占用进程 |
| 一键启动后某模块长时间未就绪 | 查看 `devtool.sh status` 输出与对应日志 |

### 评测相关

| 现象 | 可能原因 / 处理 |
|------|----------------|
| 提交后状态长时间停留在 `Pending` | noj-judge 未启动或未连上 Redis；检查 `bash scripts/dev/devtool.sh status` 与 `scripts/dev/logs/judge.log` |
| 结果丢失 / 队列堆积 | 查看 Redis 长度：`redis-cli LLEN noj:judge:queue`；必要时重启 `noj-judge` 触发自动重连 |
| 评测结果报错 `noj-download://` 解码失败 | `deno task build-packages` 重新构建题目支持包 |
| 容器启动失败 `image not found` | 默认评测镜像为本地 `noj-judge-python`；检查 `noj-judge/docker/` 构建脚本 |

### 数据库相关

| 现象 | 可能原因 / 处理 |
|------|----------------|
| 迁移失败 | `cd noj-core && deno task migrate` 查看脱敏日志；常见原因是顺序错乱或与已应用迁移冲突 |
| 种子数据缺失 / 管理员未创建 | 确认 `noj-core/.env` 已配置 `ADMIN_EMAIL`；必要时重新运行 `deno task seed` |
| 想清空重置 | `docker compose down -v` 删除数据卷后重新 `up -d` + `deno task setup` |

### 日志位置

- 一键脚本：`scripts/dev/logs/{core,ui,judge}.log`（infra 由 docker compose 管理，无单独日志文件）
- 手动运行：直接查看前台终端
- 队列状态页：<http://localhost:3000/queue>（前端）
- 结构化状态：`bash scripts/dev/devtool.sh status --json`

更多 FAQ 见 [`scripts/dev/README.md`](./scripts/dev/README.md) 与 [`noj-docs/`](./noj-docs/) 文档站。

---

## 开发流程

本项目使用 OpenSpec 规范驱动开发：

1. 在 `openspec/specs/` 定义行为规范
2. 创建变更提案 `openspec/changes/<name>/`
3. 实现 → 测试 → 归档变更

### 版本控制

- 本地使用 **Jujutsu (jj)** 管理仓库，推送使用 `jj git push`
- 所有提交必须 **GPG 签名**，`Conventional Commits` 规范（中文描述）
- 禁止直接推送到 `main`，所有变更通过 PR 合入

完整的开发约定见 [`AGENTS.md`](./AGENTS.md) 以及各子模块的 `CLAUDE.md`：
[`noj-core`](./noj-core/CLAUDE.md) · [`noj-ui`](./noj-ui/CLAUDE.md) · [`noj-judge`](./noj-judge/CLAUDE.md)。

### 测试

```bash
# noj-core 单元 + 集成测试（67 个测试文件）
cd noj-core && deno task test

# noj-judge 单元测试
cd noj-judge && cargo test --lib

# noj-judge Docker 沙箱 E2E（需要 Docker 与 NOJ_RUN_E2E=1，7 个测试）
cd noj-judge && NOJ_RUN_E2E=1 cargo test --test e2e -- --ignored

# 跨模块全链路 E2E（17 个测试文件，需先启动完整环境）
cd noj-tests && deno task test
```

CI 通过 GitHub Actions 双重流水线保证质量：

- **`ci.yml`** — PR/推送触发，并行检查三个模块（fmt + lint + test + build）
- **`e2e.yml`** — 全链路管道测试（首次 ~15min，缓存命中后 ~5-8min）

---

## 项目状态与路线图

当前处于 **Phase 1（MVP）** 阶段——已打通"注册 → 做题 → 提交 → 评测结果"闭环，并具备题目筛选、管理后台、用户榜单、每日签到、站内私信等核心功能。当前遗留项：多语言评测（C++/Java/Node.js）、SPJ（Special Judge）。

| 阶段 | 交付标准 | 状态 |
|------|---------|------|
| **Phase 0** | 浏览器注册 → 做题 → 提交 → 看到评测结果 | ✅ 完成 |
| **Phase 1** | 榜单可查，题目可筛选，管理后台可用 | 🚧 进行中 |
| **Phase 2** | 可创建比赛 → 用户参赛 → 实时榜单 → 赛后复盘 | ⏳ 规划 |
| **Phase 3** | 多 Worker 并发评测，99.5% 可用性 | ⏳ 规划 |

详见 [`ROADMAP.md`](./ROADMAP.md)。

---

## 文档

- 用户文档站（做题人 / 运营者 / 出题人）：[`noj-docs/`](./noj-docs/)
- 开发者总览：[`AGENTS.md`](./AGENTS.md)
- 各模块详细约定：[`noj-core/CLAUDE.md`](./noj-core/CLAUDE.md) · [`noj-ui/CLAUDE.md`](./noj-ui/CLAUDE.md) · [`noj-judge/CLAUDE.md`](./noj-judge/CLAUDE.md)
- 跨模块 E2E 测试指南：[`noj-tests/E2E_TESTING.md`](./noj-tests/E2E_TESTING.md)

---

## 贡献

欢迎以 PR 形式贡献代码。请先阅读 [`AGENTS.md`](./AGENTS.md) 中的贡献流程，重点关注：

- 所有提交必须 GPG 签名
- 通过 PR 合入，禁止直推 `main`
- 遵循 OpenSpec 规范驱动流程

---

## 许可证

本项目基于 [GNU Affero General Public License v3.0](./LICENSE) 开源。