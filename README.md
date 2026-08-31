# Neuro OJ

**面向 AI 领域认证与竞赛的开源在线评测平台。**

[![Deno](https://img.shields.io/badge/Deno-2.x-000?logo=deno&logoColor=fff)](https://deno.com)
[![Rust](https://img.shields.io/badge/Rust-2021-dea584?logo=rust&logoColor=000)](https://www.rust-lang.org/)
[![Nuxt 4](https://img.shields.io/badge/Nuxt-4-00DC82?logo=nuxt&logoColor=fff)](https://nuxt.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=fff)](https://www.postgresql.org/)
[![Redis](https://img.shields.io/badge/Redis-7-FF4438?logo=redis&logoColor=fff)](https://redis.io/)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue)](./LICENSE)
[![CI](https://github.com/Neuro-OJ/neuro-oj/actions/workflows/ci.yml/badge.svg)](https://github.com/Neuro-OJ/neuro-oj/actions/workflows/ci.yml)

> Neuro OJ（NOJ）是独立社区项目，与 CCF、LMCC、IOAI 及 NOAI 无任何官方关系。

## 这是什么？

NOJ 提供从“注册 → 做题 → 提交 → 评测”的完整流程，可用于 **LMCC 备考与模拟训练**、AI 训练营、教学实训和模型评测竞赛。

它与传统 OJ 的主要区别是：题目通过 evaluator 调用用户实现的函数并完成评分，而不是只比较标准输入输出。这种方式更适合评测大模型应用和 AI 工程能力。

## 可以用来做什么？

- **备考 LMCC**：组织客观题练习、编程题训练和模拟测验，复现“知识理解 + 编程实践”的训练流程。
- **AI 认证与选拔**：搭建面向 AI 基础知识、模型应用和工程能力的考试或选拔活动。
- **课程与训练营**：发布作业、自动评测代码，并集中查看提交记录和成绩。
- **AI 模型评测竞赛**：支持 LLM 工程题、模型调用题和类 Kaggle 的产物提交题。
- **社区刷题**：通过题目、排行榜、竞赛和社区功能开展日常练习与交流。

> NOJ 可以作为 LMCC 备考和模拟训练平台使用，但不是 LMCC 官方平台，也不代表任何官方认证结果。

## 支持的题型

| 题型 | 状态 | 适合场景 | 评测方式 |
| --- | --- | --- | --- |
| **客观题** | ✅ 已支持 | AI 基础知识、模型原理、伦理与安全等知识练习 | 单选、多选、判断和套卷，提交后即时判分 |
| **代码题** | ✅ 已支持 | 编程基础、算法和 AI 工程编程训练 | 在 Docker 沙箱中调用用户实现的函数并评分 |
| **LLM 工程题** | ✅ 已支持 | Prompt、RAG、工具调用和 Agent 能力评测 | 由 evaluator 调用模型或工具并按自定义规则评分 |
| **产物提交题** | ✅ 已支持 | 模型评测、预测任务和类 Kaggle 竞赛 | 上传 ZIP 产物，由平台统一评测并参与竞赛排名 |

## 和传统 OJ 有什么不同？

| 对比项 | 传统算法 OJ | Neuro OJ |
| --- | --- | --- |
| **主要目标** | 算法训练和程序设计竞赛 | AI 认证备考、AI 工程训练和模型评测 |
| **评测对象** | 读取标准输入、输出结果的完整程序 | 用户实现的函数、模型调用或提交的产物 |
| **判题方式** | 比较标准输出，或交给 SPJ 判断 | evaluator 主动调用并执行自定义评分逻辑 |
| **题目类型** | 以算法和数据结构题为主 | 客观题、代码题、LLM 工程题和产物提交题 |
| **运行隔离** | 通常运行一个用户程序 | 用户代码与评测代码在独立 Docker 容器中运行 |
| **适合场景** | 算法竞赛、编程基础训练 | LMCC 备考、AI 认证、LLM 应用和模型评测 |

NOJ 并不排斥传统编程题，而是在函数式代码评测的基础上，进一步覆盖客观题、LLM 工程题和 AI 模型评测场景。

> NOJ 当前不提供 LLM 训练或微调算力。相关训练或微调需要在选手自己的设备上完成；训练产物可以上传到 NOJ 并由平台统一评测。

## 核心能力

- **函数调用型评测**：由 evaluator 驱动测试并自定义评分逻辑。
- **双容器安全沙箱**：用户代码与评测代码隔离运行；Solution 永远关闭网络，Evaluator 可按题目配置联网并受资源限制。
- **完整竞赛体验**：支持题目筛选、提交记录、排行榜、竞赛和实时评测状态。
- **社区与权限管理**：支持社区互动、站内私信和 RBAC 权限控制。
- **LLM 调用网关**：统一管理 Provider、访问凭据、限流和用量审计。

## 快速开始

本节介绍生产环境部署。NOJ 当前采用单机 Docker Compose 方案，使用 GitHub Container Registry 发布的镜像运行。

### 环境要求

#### 必须具备

| 条件 | 用途 |
| --- | --- |
| Linux amd64 服务器 | 运行生产 Compose 和 Judge Worker |
| [Docker Engine](https://docs.docker.com/engine/install/) 与 Docker Compose v2 | 启动 NOJ 的全部生产服务 |
| OpenSSL | 首次运行安装脚本时生成随机密钥 |
| 一个已经解析到服务器的域名（公网生产部署） | 对外访问 NOJ，并用于生成 HTTPS 应用地址和 CORS 配置 |
| Nginx、Caddy 或云负载均衡（三选一） | 在容器外完成 HTTPS/TLS 终止；不要求必须安装宿主机 Nginx |
| 可拉取 `ghcr.io/neuro-oj/` 生产镜像的网络或凭据 | 获取 `noj-server`、`noj-ui`、`noj-judge` 等镜像 |
| 独立的 rootless Docker daemon socket（启用 Judge 时） | 供 Judge Worker 创建评测容器；禁止使用应用宿主机的 `/var/run/docker.sock` |

如果只是查看源码或编辑配置，不需要安装上述全部运行环境。`git` 只有在从 GitHub 获取源码时才是必须的。

> 内网或临时测试可以使用 IP 和 HTTP，不需要公网域名；正式对外提供服务时，建议使用域名和 HTTPS。

### 资源要求

以下要求以 SNG 实际部署数据为基准，适用于低并发公测和正式生产的容量规划：

| 资源 | 最低要求（低并发可运行） | 推荐要求（正式生产） | SNG 实测 |
| --- | --- | --- | --- |
| CPU | ≥ 2 vCPU | ≥ 4 vCPU | 2 vCPU |
| 内存 | ≥ 264 MiB（NOJ 低负载实测） | ≥ 8 GiB | 4 GiB，可用约 1.5 GiB |
| Swap | ≥ 2 GiB | ≥ 4 GiB | 3 GiB，已使用约 1.7 GiB |
| 磁盘 | 至少保持 5 GiB 可用 | 至少保持 40 GiB 可用 | 60 GiB，剩余约 20 GiB |
| Docker 存储 | 至少预留 5 GiB | 至少预留 15 GiB | 镜像和缓存约 15 GiB |

NOJ 当前持久化数据卷约 66 MiB，生产镜像（含 Evaluator、Solution 评测镜像）逻辑大小约 2.75 GiB。实际磁盘还会受到旧版本镜像、评测缓存、日志和同机其他服务影响。

### Judge Worker 运行位置

使用本页的一键部署脚本时，可以选择让 `judge` 随 Docker Compose 运行在当前部署主机上；只有启用 Judge 时，该主机才必须配置 Judge 专用的 rootless Docker daemon 和 `JUDGE_DOCKER_SOCKET`。

但 Judge 不要求永远和 NOJ 主服务部署在同一台机器上。生产环境可以将一个或多个 Judge Worker 部署到独立主机，让它们共同消费 Redis 评测队列；每个 Worker 都需要自己的 Docker 隔离边界，并能访问 Redis 和题目支持包存储。主站一键安装脚本不负责独立 Worker 的安装，详见 [Judge Worker 运维文档](./noj-docs/docs/operators/judge-workers.md)。

生产环境还应使用仓库外、权限为 `600` 或 `400` 的备份口令文件，并仅开放 HTTPS 和运维所需的 SSH 端口。

#### 生产部署不需要

一键生产部署使用预构建镜像，因此服务器上**不需要**安装以下开发工具：

- [Deno](https://deno.com/)
- [Rust](https://www.rust-lang.org/tools/install)
- `zip` / `unzip`
- Node.js、前端依赖或本地 PostgreSQL / Redis

这些工具仅在源码开发、构建评测镜像或运行部分测试时需要，详见[项目开发约定](./AGENTS.md)。

### 一键部署

生产环境推荐直接下载 `noj-cli` 二进制作为唯一安装入口，由 `noj-cli` 完成环境
检测（doctor）与生产部署（deploy init / deploy up）：

```bash
# 下载最新版 noj-cli（GitHub Release 资产）
curl -fsSL -o noj-cli \
  https://github.com/Neuro-OJ/neuro-oj/releases/latest/download/noj-cli-linux-amd64
chmod +x noj-cli

# 环境检测
./noj-cli doctor

# 初始化并部署（示例）
./noj-cli deploy init --mode prod --dir /opt/neuro-oj
./noj-cli deploy up --dir /opt/neuro-oj
```

安装完成后，服务启停、更新和管理统一使用 `noj-cli` 命令。

部署完成后，通过配置的域名访问：

- 前端：`https://你的域名/`
- 健康检查：`https://你的域名/healthz`

生产配置至少需要填写 `NOJ_VERSION`、`DOMAIN`、`APP_URL`、`CORS_ALLOWED_ORIGINS`、数据库/Redis/MinIO 凭据、认证密钥和 `EMAIL_PROVIDER`（可以设为 `disabled`）。新站点安装完成后注册的第一个真实用户会自动成为管理员；启用 Judge 时才需要独立的 Judge Docker socket。完整配置说明见[生产部署文档](./noj-docs/docs/operators/production-deploy.md)。

常用运维命令：

```bash
noj-cli doctor                      # 环境检测
noj-cli deploy status               # 查看服务状态
noj-cli maintain logs server        # 查看 server 日志
noj-cli deploy restart              # 重启服务
noj-cli deploy down                 # 停止服务但保留数据卷
noj-cli deploy up                   # 再次启动
noj-cli maintain backup create      # 创建生产备份
noj-cli maintain config check       # 只校验配置，不改变服务状态
```

`noj-cli` 是统一部署与运维入口，覆盖 `doctor`、`deploy`、`maintain`、`run-server`
与 `version`。`noj-cli` 不提供升级/卸载子命令；配置变更与数据管理见
`noj-cli maintain config` 与 `noj-cli maintain reset`。

更多部署、TLS、备份和升级说明见 [`deploy/README.md`](./deploy/README.md) 和[生产部署文档](./noj-docs/docs/operators/production-deploy.md)。

## 按角色开始

| 你是谁 | 可以做什么 | 从这里开始 |
| --- | --- | --- |
| 做题人 | 刷题、提交代码、查看结果、参加竞赛 | [`做题人文档`](./noj-docs/docs/users/index.md) |
| 出题人 | 创建代码题、LLM 题和评测支持包 | [`出题人文档`](./noj-docs/docs/problemsetters/index.md) |
| 运营者 | 部署、初始化和维护 NOJ 实例 | [`运营者文档`](./noj-docs/docs/operators/index.md) |
| 开发者 | 修改代码、运行测试、提交贡献 | [`项目开发约定`](./AGENTS.md) |

### 常用文档

- [什么是 Neuro OJ](./noj-docs/docs/intro/what-is-noj.md)：了解评测模型与传统 OJ 的区别
- [快速开始](./noj-docs/docs/intro/getting-started.md)：完成第一次注册、做题和提交
- [生产部署](./noj-docs/docs/operators/production-deploy.md)：部署一个可用的 NOJ 实例
- [评测模型](./noj-docs/docs/mechanisms/judge-model.md)：了解 evaluator、solution 和双容器架构
- [系统架构](./noj-docs/docs/system/architecture.md)：了解各服务之间如何协作
- [常见问题](./noj-docs/docs/intro/faq.md)：排查常见使用和部署问题

如果项目提供了在线文档站，建议从文档站首页开始阅读；仓库中的 [`noj-docs`](./noj-docs/) 是文档站源码。

## 项目结构

```text
noj-ui            Nuxt 4 + Vue 3 前端
noj-core          Deno + Hono API 与业务服务
noj-judge         Rust + Docker 评测 Worker
noj-llm-gateway   LLM 调用网关
noj-tests         跨模块全链路测试
noj-docs          用户、运营者和出题人文档
```

核心评测链路如下：

```text
浏览器 → noj-ui → noj-core → Redis 队列 → noj-judge → 评测结果
                         ├→ PostgreSQL
                         └→ noj-llm-gateway（可选）
```

## 项目状态

当前已打通注册、做题、提交、评测结果、题目筛选、排行榜、竞赛、社区、站内私信和 RBAC 等能力；客观题、代码题、LLM 工程题和产物提交题已经可以使用。

正在持续完善 AI 认证和竞赛场景，包括考试模式、隐藏测试集、更多竞赛赛制和赛后复盘能力。

## 故障排查

- 提交长时间处于 `Pending`：确认 Judge Worker 已启动，并且连接了与 `noj-core` 相同的 Redis；队列和日志排查方法见[Judge Worker 运维文档](./noj-docs/docs/operators/judge-workers.md)。
- 评测镜像不存在：确认评测镜像已发布、已加入 `judge_images` 白名单，并检查 Judge Worker 的镜像前缀配置。
- 生产服务启动失败：执行 `noj-cli doctor`、`noj-cli deploy status` 和 `noj-cli maintain logs <service>` 查看状态与日志。
- 密码重置邮件不可用：检查 `EMAIL_PROVIDER` 及对应凭据；暂时不配置邮件时可以使用 `disabled`，但密码找回功能不可用。

更多常见问题见[常见问题](./noj-docs/docs/intro/faq.md)。

## 品牌与设计

NOJ 使用统一的「暖纸评测风」品牌视觉：暖纸底、墨字、蓝黑墨品牌蓝 `#1B2B4A` 与评测信号绿 `#00d68a`。设计 token 与使用规范见 [`docs/design/noj-design-tokens.md`](./docs/design/noj-design-tokens.md)。

## 参与贡献

欢迎通过 Issue 和 Pull Request 参与项目。开始修改代码前，请先阅读 [`AGENTS.md`](./AGENTS.md)；其中包含开发流程、测试方式、OpenSpec 规范和提交要求。

- [提交 Issue](https://github.com/Neuro-OJ/neuro-oj/issues)
- [查看 CI](https://github.com/Neuro-OJ/neuro-oj/actions)
- [项目详细约定](./AGENTS.md)

## 许可证

本项目基于 [GNU Affero General Public License v3.0](./LICENSE) 开源。
