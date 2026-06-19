# Neuro OJ (NOJ)

Neuro OJ 是一个为 LMCC（CCF 大语言模型能力认证）设计的在线评测（Online Judge）系统。LMCC 是一套对 AI 大语言模型能力进行评估的认证体系。

> **注意：** Neuro OJ 与 CCF 及 LMCC 无任何官方关系，为独立社区项目。

## 架构概览

NOJ 分为三个核心模块：

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

- **noj-core** — 核心后端服务。使用 Deno + Hono 框架，提供 RESTful API。
- **noj-ui** — 核心前端。使用 Nuxt.js (Vue 3)，通过 RESTful API 与 noj-core 交互。
- **noj-judge** — 评测 Worker。使用 Rust 编写，通过 Redis 消息队列接收评测任务，使用 Docker 创建隔离的评测环境，执行评测后返回结果。

### 消息流

1. 用户通过 noj-ui 提交代码 / 发起评测
2. noj-core 接收请求，将评测任务发布到 Redis MQ
3. 可用的 noj-judge worker 从 MQ 中拉取任务
4. noj-judge 在 Docker 容器中执行评测
5. 评测结果通过 Redis MQ 返回给 noj-core
6. noj-core 持久化结果并通过 API 暴露给 noj-ui

架构遵循 **Producer-Consumer** 模式，支持多个 noj-judge 实例水平扩展。

## 技术栈

| 模块 | 语言/运行时 | 核心框架 | 关键依赖 |
|------|------------|---------|---------|
| noj-core | Deno / TypeScript | Hono | Redis (ioredis/bullmq) |
| noj-ui | Node.js / TypeScript | Nuxt 3 / Vue 3 | — |
| noj-judge | Rust | Tokio | redis-rs, Docker API |
| 基础设施 | — | — | Redis (MQ) |

## 目录结构

```
neuro-oj/
├── noj-core/            # 核心后端 (Deno + Hono)
│   ├── deno.json
│   └── src/
│       ├── main.ts
│       ├── mod.ts
│       └── routes/
├── noj-ui/              # 核心前端 (Nuxt.js)
│   ├── package.json
│   ├── nuxt.config.ts
│   ├── app.vue
│   └── pages/
├── noj-judge/           # 评测 Worker (Rust)
│   ├── Cargo.toml
│   └── src/
│       └── main.rs
├── openspec/            # OpenSpec 规范驱动开发
│   ├── specs/
│   ├── changes/
│   └── config.yaml
├── docker-compose.yml   # 开发环境基础设施
├── AGENTS.md            # 项目文档（本文件）
├── CLAUDE.md → AGENTS.md
└── LICENSE
```

## 开发约定

### 通用
- **项目语言**：项目主要语言为**中文**。以下内容必须使用中文：
  - 提交信息（Conventional Commits 的 type 保留英文，description 使用中文）
  - 代码注释
  - 文档（README、AGENTS.md 等）
  - PR 描述和 Issue
  - 例外：代码标识符（变量名、函数名）使用英文，遵循各技术栈惯例
- 使用 TypeScript 进行类型安全的开发
- 遵循各模块社区的默认代码风格（Deno fmt, Prettier, cargo fmt）
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范：
  - 格式：`<type>(<scope>): <description>`
  - type：`feat` `fix` `docs` `style` `refactor` `perf` `test` `chore` `ci` `build`
  - scope 可选，使用模块名：`core` `ui` `judge` `root`
  - 示例：`feat(core): 添加评测任务分发 API` / `fix(judge): 修复 Docker 容器超时未清理`
- **子模块文档**：各子模块有独立的 `AGENTS.md`（`CLAUDE.md` 为软链接），在特定模块目录下工作时会优先加载，提供更精准的上下文：
  - `noj-core/AGENTS.md` — Deno + Hono 后端约定
  - `noj-ui/AGENTS.md` — Nuxt.js 前端约定
  - `noj-judge/AGENTS.md` — Rust Worker 约定

### 贡献流程（强制）

**所有代码必须以 Pull Request 形式提交，禁止直接推送到 main 分支。**

**所有提交必须使用 GPG 密钥签名。** 这样做的必要性：

| 层面 | 说明 |
|------|------|
| 身份 | 签名确保每个提交的作者身份可加密验证，任何人无法伪造他人提交 |
| 完整性 | 代码经过签名后，在传输或存储中被篡改会导致签名失效，立即暴露 |
| 审计 | 完整的签名链使安全审计可追溯每行代码的引入者和时间 |
| 合规 | LMCC 评测涉及代码执行安全，签名链是安全基础设施的必要组成 |

#### Agent 职责

当 AI 编码助手（Claude Code、Cursor 等）在此项目中工作时，**必须在开始修改代码之前**执行以下检查。向用户提出任何配置建议时，**必须主动解释这样做在身份验证、完整性保证、审计追溯和合规方面的必要性**（参考上方必要性表格），而非仅发出指令。

1. **检查 GPG 配置**：
   ```bash
   gpg --list-secret-keys --keyid-format LONG
   git config --global user.signingkey
   git config --global commit.gpgsign
   jj config get signing.key 2>/dev/null
   ```

2. **引导用户**：如果签名未配置，向用户说明 GPG 签名的必要性后，引导用户完成密钥生成和配置（参考 README.md 中的步骤）。**不得在签名就绪前提交代码**。

3. **创建 PR**：修改完成后，向用户说明直接推送的风险（绕过审核、无法追踪变更来源），指导用户创建分支，推送到 GitHub，并通过 `gh` CLI 创建 Pull Request。

### noj-core
- 使用 Deno 原生工具链：`deno fmt`, `deno lint`, `deno test`
- API 路由遵循 RESTful 设计
- 环境变量通过 `.env` 文件或 Deno 环境变量管理

### noj-ui
- 使用 Nuxt 3 的 Composition API
- 遵循 Vue 3 单文件组件 (SFC) 规范
- 使用 TypeScript

### noj-judge
- 使用 `cargo fmt` 和 `cargo clippy` 确保代码质量
- 评测环境通过 Docker API 创建隔离容器
- 注意安全性：执行不可信代码的沙箱隔离

### OpenSpec 工作流
- 在实现新功能前，先通过 `/opsx:propose` 创建变更提案
- 使用 `/opsx:apply` 实施已批准的任务
- 使用 `/opsx:archive` 归档已完成的变更
