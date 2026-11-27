# 模块地图与架构方向

> 根 [`AGENTS.md`](../../AGENTS.md)
> 的落点：模块职责、目录、文档加载顺序与参考文档； 模块细节以各模块文档为准。
>
> 平台支持客观题、代码题、LLM 工程题与产物提交（类 Kaggle）评测；与 CCF、LMCC、
> IOAI 及 NOAI 无官方关系，为独立社区项目。

## 1. 仓库形态：单仓库多模块（monorepo）

本仓库是**单仓库多模块**：一个 git 仓库里放着 5 个可独立部署的模块（core / ui / judge /
gateway / cli）以及测试、文档与运维脚本，共用一套门禁、一份变更日志与一次发布节奏。
VS Code 扩展原为本仓的 `noj-lmcc-extension`，已于 2026-11-26 拆到独立仓库
[`Neuro-OJ/noj-vscode`](https://github.com/Neuro-OJ/noj-vscode)（#794）。

注意它不是 JS workspace 那种形态，两点区别要记住：

- **没有统一的依赖管理**：各模块有自己的 `deno.json` / `Cargo.toml` / `package.json`，版本
  不联动，升级按模块各自提（提交 scope 用 `deps`）。
- **没有统一的构建图**：构建与测试按模块跑，CI 用 `working-directory` 分模块，再由
  `scripts/select-core-ci.ts` 之类的路径筛选决定跑哪些 job。

跨模块约束靠门禁维护：`scripts/check-module-boundaries.ts`（依赖方向、表归属）与
`check-feature-boundaries.ts`（feature 切片），配置在
[`module-boundaries.json`](../engineering/module-boundaries.json)。

选择单仓库的依据是改动相关性：近 120 天的代码提交里约 **47% 同时改动 ≥2 个模块**
（`core+ui` 组合 34 次最常见）。拆成多仓库会让多数功能改动跨 2–3 次 PR。

例外：`noj-problems/` 是独立私有仓库（主仓库 gitignore），不属于本 monorepo。

### 1.1 何时考虑拆仓（2026-11-22 评估快照，当时 lmcc 仍在仓内；该判断已被 #794 验证）

判据六条，前两条判「能不能切」，后四条判「值不值得切」：

1. **同步率**：改它时**必须**同时改别的模块吗（不是「经常」，是「必须」）。
2. **自包含率**：近 6 个月纯独改提交占比，低于 5% 基本等于绑死。
3. **发布节奏**：要不要独立发版、独立版本号、独立分发渠道。
4. **工具链重叠**：构建/测试/依赖与主仓有无交集。
5. **信任边界**：需不需要不同权限、审计或构件仓库。
6. **检出成本**：对 clone 与 IDE 索引的负担。

近 180 天（499 个提交）实测的跨模块改动占比：`noj-llm-gateway` 93.9%、`noj-cli` 100%、
`noj-lmcc-extension` 100%、`noj-tests` 98.8%、`noj-docs` 94.8%、`noj-core` 92.1%、
`noj-judge` 87.2%、`noj-ui` 79.2%（纯独改 45 次，全仓最高）。

**结论：按耦合度一个都不该切**——最自包含的 `noj-ui` 也有近 80% 的提交动到别的模块。
若业务上必须切，顺序是：

- **先切 `noj-lmcc-extension`**：20 个文件、半年 5 次改动、Node 工具链与主仓零重叠、独立
  VSIX 分发、只走 core 的 HTTP API。它的「100% 跨模块」是假信号——那 5 次是跟着 core 的
  接口同步改，不是逻辑耦合。
- **`noj-judge` 可作第二候选，但有前置条件**：core 与 judge 的契约现在是「Redis 消息 + 两套
  手写结构体」。一致性靠**测试快照**而不是共享类型：任务侧由 TS 与 Rust 共用同一份
  `noj-tests/fixtures/judge-task.contract.json`（及 `-oi` 变体），
  `judge_task_contract.rs` 与 `judge-task-contract.test.ts` 各自对同一份 JSON 断言；
  结果侧 `judge_result_contract.rs` 用字段清单钉住 wire 字段，清单需与 core 的
  `JudgeResult` 接口手工同步。但**尚未**有共享 schema（JSON Schema）或由 schema 生成的
  类型，字段变更仍要手改两套结构体和两侧测试。先形式化契约（JSON Schema / 生成类型），
  再谈拆；否则切出去只会让最脆的链路更难改。

**不要切**：`noj-cli`（承载部署知识：compose、迁移顺序、备份）、`noj-llm-gateway`（与 core
共用同一个 PostgreSQL，切仓等于跨仓管 schema）、`noj-core`（中心）、`noj-ui`（耦合最低但
变更最频繁，216 次）。

无论是否拆仓，都应先把两份契约固化成 schema：core↔judge 的消息契约、core↔ui 的 API
契约（现状是两套手写结构体 + 快照测试）。做完之后任何拆仓的成本都会下降一个数量级。

## 2. 模块与协作

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

## 3. 目录与用途

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

## 4. 开发默认凭据

| 服务       | 地址                            | 凭据                      |
| ---------- | ------------------------------- | ------------------------- |
| PostgreSQL | `localhost:5432`                | `noj / noj / noj`         |
| Redis      | `localhost:6379`                | 无认证                    |
| MinIO      | `9000`（API）/ `9001`（控制台） | `minioadmin / minioadmin` |

## 5. 架构方向（重构中）

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

## 6. 文档加载顺序

进模块目录前先读对应文档；涉及对应领域时加载环境提供的技能。

| 路径                               | 优先加载                                   |
| ---------------------------------- | ------------------------------------------ |
| `noj-core/` `noj-ui/` `noj-judge/` | 各自 `AGENTS.md`（`CLAUDE.md` 为软链接）   |
| `noj-llm-gateway/`                 | `noj-llm-gateway/CLAUDE.md`                |
| `noj-cli/`                         | `noj-cli/README.md`                        |
| `noj-tests/`                       | `noj-tests/E2E_TESTING.md`                 |

## 7. 参考文档

| 文档               | 路径                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 模块约定           | [`noj-core/AGENTS.md`](../../noj-core/AGENTS.md)、[`noj-ui/AGENTS.md`](../../noj-ui/AGENTS.md)、[`noj-judge/AGENTS.md`](../../noj-judge/AGENTS.md) |
| noj-cli / 生产部署 | [`noj-cli/README.md`](../../noj-cli/README.md)、[production-deploy.md](../../noj-docs/docs/operators/production-deploy.md)                         |
| E2E 测试指南       | [`noj-tests/E2E_TESTING.md`](../../noj-tests/E2E_TESTING.md)                                                                                       |
| 工程规范           | [`dev-docs/engineering/README.md`](../engineering/README.md)                                                                                       |
| core 重构提案      | [`dev-docs/refactor/core-feature-slices/`](../../dev-docs/refactor/core-feature-slices/)                                                           |
| 品牌设计 Token     | [`dev-docs/design/noj-design-tokens.md`](../design/noj-design-tokens.md)                                                                           |
