# NOJ · Neuro OJ

<div align="center">

**面向大模型能力评测场景的在线评测系统**

[![Deno](https://img.shields.io/badge/Deno-0.1.0-000?logo=deno&logoColor=fff)](https://deno.com)
[![Rust](https://img.shields.io/badge/Rust-0.1.0-dea584?logo=rust&logoColor=000)](https://rust-lang.org)
[![Nuxt](https://img.shields.io/badge/Nuxt_3-0.1.0-00DC82?logo=nuxt&logoColor=fff)](https://nuxt.com)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=fff)](https://postgresql.org)
[![Redis](https://img.shields.io/badge/Redis-7-FF4438?logo=redis&logoColor=fff)](https://redis.io)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue)](./LICENSE)

> ⚠️ **Neuro OJ 为独立社区项目，与 CCF（中国计算机学会）及
> LMCC（大模型能力认证）无任何官方关系。**

</div>

---

## 📌 什么是 Neuro OJ？

Neuro OJ（简称 **NOJ**）是一个为大模型能力评测场景设计的在线评测（Online
Judge）系统。

传统的 OJ（如
POJ、Codeforces）面向**算法竞赛**，评测的是标准输入/输出下的程序正确性。NOJ
面向的是**大模型实操能力评测**——指令微调、提示工程、Agent
构建、模型对齐等编程任务——这些任务需要灵活的评测逻辑、资源隔离和可扩展的 Worker
架构。

### 典型场景

- **教学实训** — 大模型课程中的编程作业自动评测
- **能力认证** — 支持类似 LMCC 第二轮编程题的机考环境
- **模型评测** — 自动化评估模型在特定任务上的表现

---

## ✨ 特性

|    | 特性                       | 说明                                                    |
| -- | -------------------------- | ------------------------------------------------------- |
| 🐳 | **Docker 沙箱隔离**        | 每个评测在独立容器中执行，资源受限，安全可靠            |
| 🦀 | **Rust 评测 Worker**       | 高性能、低延迟，支持水平扩展                            |
| 🔄 | **Producer-Consumer 架构** | 基于 Redis MQ 解耦，多 Worker 并发消费                  |
| 🎯 | **灵活评测逻辑**           | 支持包（support package）机制，每个题目可自定义评测脚本 |
| 🌐 | **RESTful API**            | 前后端通过标准 API 通信，易于集成                       |
| 🗄️ | **PostgreSQL + Drizzle**   | 类型安全的 ORM，迁移友好                                |
| 🔌 | **多语言支持**             | 可扩展的 Judge 镜像体系                                 |

---

## 🏗️ 系统架构

NOJ 由三个核心模块组成，通过 RESTful API 和 Redis 消息队列协作：

```
┌──────────┐   RESTful API   ┌──────────┐   Redis MQ    ┌──────────────┐
│  noj-ui  │ ◄─────────────► │ noj-core │ ──Producer──► │  noj-judge   │
│  Nuxt.js  │                 │Deno+Hono │ ◄──Consumer──│  Rust+Docker │
└──────────┘                 └──────────┘               └──────────────┘
                                   │
                              ┌────┴────┐
                              │  Redis   │
                              └─────────┘
```

### 消息流

1. **用户**通过 noj-ui 提交代码
2. **noj-core** 接收请求，将评测任务发布到 Redis MQ
3. **noj-judge Worker** 从 MQ 拉取任务
4. Worker 在 **Docker 容器**中执行评测
5. 结果通过 Redis MQ 返回给 noj-core
6. **noj-core** 持久化结果并通过 API 暴露

---

## 🚀 快速开始

### 环境要求

- [Deno](https://deno.com)
- [Node.js](https://nodejs.org/) >= 20
- [Rust](https://www.rust-lang.org/)
- [Docker](https://www.docker.com/)

### 启动基础设施

```bash
# 启动 Redis（消息队列）和 PostgreSQL（数据存储）
docker compose up -d
```

### 启动后端 (noj-core)

```bash
cd noj-core

# 初始化数据库并填充种子数据
deno task setup

# 启动开发服务器（带文件监听）
deno task dev
```

### 启动前端 (noj-ui)

```bash
cd noj-ui

# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

### 启动评测 Worker (noj-judge)

```bash
cd noj-judge

# 编译并运行
cargo run
```

> 💡 三模块可独立启动，开发时可以只跑需要的部分。

---

## 🛠️ 技术栈

| 模块          | 语言/运行时          | 核心框架                           | 关键依赖                                                                                                                          |
| ------------- | -------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **noj-core**  | Deno / TypeScript    | [Hono](https://hono.dev)           | [Drizzle ORM](https://orm.drizzle.team), [ioredis](https://github.com/redis/ioredis), [Jose (JWT)](https://github.com/panva/jose) |
| **noj-ui**    | Node.js / TypeScript | [Nuxt 3](https://nuxt.com) / Vue 3 | —                                                                                                                                 |
| **noj-judge** | Rust                 | [Tokio](https://tokio.rs)          | [bollard (Docker API)](https://github.com/fussybeaver/bollard), [redis-rs](https://github.com/redis-rs/redis-rs)                  |
| **基础设施**  | —                    | —                                  | PostgreSQL 16, Redis 7                                                                                                            |

---

## 📂 项目结构

```
neuro-oj/
├── noj-core/             # 核心后端 — RESTful API 服务
│   ├── src/
│   │   ├── main.ts       # 入口
│   │   ├── mod.ts        # 模块导出
│   │   └── routes/       # API 路由
│   └── deno.json
├── noj-ui/               # 前端 — 用户界面
│   ├── pages/            # 页面组件
│   ├── app.vue           # 应用入口
│   └── nuxt.config.ts
├── noj-judge/            # 评测 Worker — 执行引擎
│   ├── src/
│   │   └── main.rs
│   └── Cargo.toml
├── openspec/             # OpenSpec 规范驱动开发
├── scripts/              # 构建与维护脚本
├── docker-compose.yml    # 基础设施（Redis + PostgreSQL）
├── AGENTS.md             # AI 编码助手指引
├── ROADMAP.md            # 开发路线图
└── LICENSE               # AGPL-3.0
```

---

## 🗺️ 路线图

项目当前处于 **Phase 0（MVP）** 阶段，目标为打通"提交 → 评测 → 结果"闭环。

| 阶段    | 交付标准                                    |
| ------- | ------------------------------------------- |
| Phase 0 | 浏览器注册 → 做题 → 提交 → 看到评测结果     |
| Phase 1 | 榜单可查，题目可筛选，管理后台可用          |
| Phase 2 | 可创建比赛 → 用户参赛 → 实时榜单 → 赛后复盘 |
| Phase 3 | 多 Worker 并发评测，99.5% 可用性            |

详见 [ROADMAP.md](./ROADMAP.md)。

---

## 🤝 贡献

欢迎贡献！本项目有严格的代码签名和 PR 流程要求：

- **GPG 签名** — 所有提交必须使用 GPG 密钥签名
- **PR 流程** — 禁止直接推送到 main 分支，所有变更通过 Pull Request 合入

详细的贡献指南、开发约定和 GPG 配置步骤见 [AGENTS.md](./AGENTS.md)。

---

## 🧪 测试

### 跨模块全链路 E2E 测试

跨 noj-core 和 noj-judge 的全链路管道测试位于 `noj-tests/` 包中：

```bash
cd noj-tests
NOJ_RUN_E2E=1 deno task test:e2e
```

详见 [noj-tests/E2E_TESTING.md](noj-tests/E2E_TESTING.md)。

### 各模块测试

- **noj-core**：`cd noj-core && deno task test`
- **noj-judge 单元测试**：`cd noj-judge && cargo test`
- **noj-judge Docker 沙箱测试**：`cd noj-judge && NOJ_RUN_E2E=1 cargo test -- --ignored`

---

## 📄 许可证

本项目基于 **GNU Affero General Public License v3.0** 开源，详见
[LICENSE](./LICENSE)。
