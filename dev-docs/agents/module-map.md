# 模块地图与架构方向

> 根 [`AGENTS.md`](../../AGENTS.md)
> 的落点：模块职责、目录、文档加载顺序与参考文档； 模块细节以各模块文档为准。
>
> 平台支持客观题、代码题、LLM 工程题与产物提交（类 Kaggle）评测；与 CCF、LMCC、
> IOAI 及 NOAI 无官方关系，为独立社区项目。

## 1. 模块与协作

各模块通过 RESTful API、Redis MQ 和内部 HTTP 服务协作。

| 模块               | 运行时                             | 职责                                                                         |
| ------------------ | ---------------------------------- | ---------------------------------------------------------------------------- |
| noj-core           | Deno 2 + Hono                      | RESTful API、JWT + 固定角色授权、业务 CRUD、Redis MQ Producer/Consumer、审计 |
| noj-ui             | Nuxt 4 + Vue 3                     | Web 前端、Nitro 代理注入 JWT Cookie                                          |
| noj-judge          | Rust + Tokio                       | Docker 沙箱评测、双容器 Evaluator + Solution                                 |
| noj-llm-gateway    | Deno + Hono                        | LLM 调用可信代理、Provider Key 加密、eval_token、限流/额度/审计              |
| noj-cli            | Deno 2（`deno compile` 单二进制）  | 生产安装、启停、升级、备份/恢复/演练、配置校验                               |

基础设施：PostgreSQL 16、Redis 7、MinIO/S3。技术栈与依赖见各模块 `deno.json` /
`Cargo.toml`；架构总览见
[architecture.md](../../noj-docs/docs/system/architecture.md)。

## 2. 目录与用途

| 路径                  | 用途                                                    |
| --------------------- | ------------------------------------------------------- |
| `noj-core/`           | 后端 API（Deno + Hono）                                 |
| `noj-ui/`             | Web 前端（Nuxt 4）                                      |
| `noj-judge/`          | 评测机（Rust）                                          |
| `noj-llm-gateway/`    | LLM 可信代理（Deno + Hono）                             |
| `noj-cli/`            | 生产运维 CLI（单二进制）                                |
| `noj-tests/`          | 跨模块 E2E 测试                                         |
| `noj-docs/`           | 文档站（架构、运维、安全、FAQ）                         |
| `dev-docs/`           | 工程规范、设计、评审与 Agent 细节（本目录）             |
| `scripts/`            | 构建与门禁脚本（边界、迁移安全、链接、Agent Note 格式） |
| `deploy/` `fixtures/` | 部署编排与测试夹具                                      |

`noj-problems/`（独立私有仓库，主仓库 gitignore）与 [`noj-vscode`](https://github.com/Neuro-OJ/noj-vscode)（VS Code 扩展独立公开仓库）均不在本仓修改。

## 3. 开发默认凭据

| 服务       | 地址                            | 凭据                      |
| ---------- | ------------------------------- | ------------------------- |
| PostgreSQL | `localhost:5432`                | `noj / noj / noj`         |
| Redis      | `localhost:6379`                | 无认证                    |
| MinIO      | `9000`（API）/ `9001`（控制台） | `minioadmin / minioadmin` |

## 4. 架构方向（重构中）

noj-core 正从 `modules/`（+ `application/` 编排层与跨模块合同层）迁移到
**`shared/` + `features/<name>/`** 两层；期间新旧结构并存，旧模块「改到即迁」。

方案与分阶段计划以
[dev-docs/refactor/core-feature-slices/](../../dev-docs/refactor/core-feature-slices/)
（`proposal.md`、`design.md`）为准；新增功能的结构与依赖规则依提案，不要自行发明。

**新功能照样例写**：复制
[`noj-core/src/features/trainings/`](../../noj-core/src/features/trainings/)
的组织方式（`index.ts` 唯一出口 + `defineFeature`），在
[`noj-core/src/features.ts`](../../noj-core/src/features.ts)
加一行即完成路由/任务/worker 装配；
[`scripts/check-feature-boundaries.ts`](../../scripts/check-feature-boundaries.ts)
强制依赖规则。

## 5. 文档加载顺序

进模块目录前先读对应文档；涉及对应领域时加载环境提供的技能。

| 路径                               | 优先加载                                   |
| ---------------------------------- | ------------------------------------------ |
| `noj-core/` `noj-ui/` `noj-judge/` | 各自 `AGENTS.md`（`CLAUDE.md` 为软链接）   |
| `noj-llm-gateway/`                 | `noj-llm-gateway/CLAUDE.md`                |
| `noj-cli/`                         | `noj-cli/README.md`                        |
| `noj-tests/`                       | `noj-tests/E2E_TESTING.md`                 |

## 6. 参考文档

| 文档               | 路径                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模块约定           | [`noj-core/AGENTS.md`](../../noj-core/AGENTS.md)、[`noj-ui/AGENTS.md`](../../noj-ui/AGENTS.md)、[`noj-judge/AGENTS.md`](../../noj-judge/AGENTS.md) |
| noj-cli / 生产部署 | [`noj-cli/README.md`](../../noj-cli/README.md)、[production-deploy.md](../../noj-docs/docs/operators/production-deploy.md)                         |
| E2E 测试指南       | [`noj-tests/E2E_TESTING.md`](../../noj-tests/E2E_TESTING.md)                                                                                       |
| 工程规范           | [`dev-docs/engineering/README.md`](../engineering/README.md)                                                                                       |
| core 重构提案      | [`dev-docs/refactor/core-feature-slices/`](../../dev-docs/refactor/core-feature-slices/)                                                           |
| 品牌设计 Token     | [`dev-docs/design/noj-design-tokens.md`](../design/noj-design-tokens.md)                                                                           |
