# Agent Note: 单仓库多模块形态与拆仓判据

Status: implemented

## Problem

仓库同时包含 `noj-core`、`noj-ui`、`noj-judge`、`noj-llm-gateway`、`noj-cli`、`noj-tests`、`noj-docs` 等多个独立运行模块，且刚完成 `noj-lmcc-extension` 到 `Neuro-OJ/noj-vscode` 的拆仓（#794）。随着模块演进与后续拆仓讨论增多，需要明确本仓库为何继续保持「单仓库多模块（非 JS workspace）」形态、后续评估拆仓的客观判据、各模块是否拆分的结论，以及拆仓前必须满足的契约固化前置条件，避免凭直觉拆仓放大跨仓协同成本。

## Decision

在 `dev-docs/agents/module-map.md` 中将本仓库正式定位为**单仓库多模块（monorepo，各模块独立依赖管理与独立构建图）**，并固化以下架构决策与判据：

1. **保持单仓库的实证依据**：基于近 120 天约 47% 提交同时修改 ≥2 个模块、近 180 天（499 次提交）跨模块占比 79.2%–100% 的统计，当前耦合度下保持单仓库可避免多数功能被拆成 2–3 个跨仓 PR。
2. **六条拆仓判据**：前两条判「能不能切」（同步率、自包含率），后四条判「值不值得切」（发布节奏、工具链重叠、信任边界、检出成本）。
3. **模块拆仓结论与顺序**：
   - `noj-lmcc-extension` 为第一优先级并已完成拆分（#794，独立 VSIX 分发、工具链零重叠、仅依赖 core HTTP API）；
   - `noj-judge` 仅可作为第二候选，**前置条件**是先将 `core↔judge` 的消息契约由“两套手写结构体 + 测试快照”形式化为共享 schema / 生成类型；
   - `noj-core`（中心）、`noj-llm-gateway`（与 core 共用 PostgreSQL schema）、`noj-cli`（承载编排与升级部署知识）、`noj-ui`（变更最频繁且近 80% 伴随跨模块改动）均不拆仓。
4. **契约固化前置原则**：无论后续是否拆仓，均应优先将 `core↔judge` 消息契约与 `core↔ui` API 契约固化为共享 schema，使跨模块改动与潜在拆仓成本下降一个数量级。

## Alternatives considered

- **按模块全面拆分为多仓库（polyrepo）**：虽然单仓更小，但近半数日常提交涉及 2 个以上模块，多仓会导致接口变更需要跨仓锁版本与多轮 PR 联调，显著拉长交付链路，尤其对共享 DB schema 的 `noj-llm-gateway` 和高变更频率的 `noj-ui` 代价过高。
- **迁移为统一依赖管理的 JS workspace（pnpm/npm workspaces）**：仓库同时包含 Deno、Nuxt/Node、Rust 等多语言工具链，强行引入单一 workspace 编排会破坏各模块独立升级与独立打包（如 `deno compile` 单二进制、Rust `Cargo.lock`）的清晰边界。
- **直接拆分 `noj-judge` 而不先形式化契约**：当前任务与结果 wire 契约依赖手写结构体与快照断言同步，直接拆仓会让最脆弱的跨语言边界难以原子演进。

## Consequences

- **正向收益**：团队与 AI Agent 对仓库形态和拆仓门槛有统一、可复核的客观标准，避免仓促拆仓引发跨仓漂移；明确把「契约 schema 化」确立为高杠杆前置任务。
- **约束与维护**：随着模块演进与契约形式化推进，若未来跨模块耦合度或发布节奏发生实质变化，应重新按六条判据复测并更新本记录与 `dev-docs/agents/module-map.md`。
