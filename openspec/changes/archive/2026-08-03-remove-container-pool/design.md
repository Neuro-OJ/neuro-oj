## Context

双容器评测架构（Evaluator + Solution，`src/dual/`）落地后，所有评测任务统一经
`judge::runner::evaluate` 即时创建容器执行，`src/judge/` 与 `src/dual/` 均不引用
`src/pool/`。容器池（`PoolManager`，约 1100 行 + `copy.rs` / `exec.rs`）仅剩启动时
初始化与后台空转，其配置（`POOL_*` 环境变量）、初始化 RPC 拉取、优雅关闭逻辑散落在
`main.rs` / `config.rs` / `lib.rs`，另有独立 E2E 测试与 CI 分组、多份文档描述。

约束：

- 评测执行路径（`judge::runner::evaluate` → `dual/`）**不得改动**，行为不得回归。
- `cargo test` / `cargo clippy` / `cargo fmt` 必须干净，无 pool 引用残留。
- 变更遵循 OpenSpec 流程，spec delta 需同步主规范。

## Goals / Non-Goals

**Goals:**

- 删除 `src/pool/` 全部代码（`mod.rs` / `copy.rs` / `exec.rs` 及单元测试）。
- 从 `main.rs` / `lib.rs` / `config.rs` 移除池初始化、后台任务、优雅关闭与 `POOL_*`
  配置读取。
- 删除 `tests/e2e_container_pool.rs` 并同步 CI 分组。
- 同步 4 个 spec delta 与全部运维文档，验收时全局无"容器池"残留。

**Non-Goals:**

- 不重构 `judge::runner::evaluate` 或 `dual/` 评测编排逻辑。
- 不删除 `mq/rpc.rs` 的 RPC 基础设施与 `RpcClient::get_image_allowlist` /
  `ImageAllowlist`（core 侧 judge-image-whitelist 能力独立存在）。
- 不调整 `drain.rs` 的 in-flight 任务排空机制（与容器池无关）。
- 不修改 `env.e2e.template`（其中 `DATABASE_POOL_MAX` 为 PG 连接池配置，与容器池无关）。

## Decisions

### D1：`src/pool/` 整体删除，不迁移 copy.rs 能力

`pool/copy.rs` 提供 tar 打包 + docker exec 注入；`dual/mod.rs` 的
`inject_support_package_to_evaluator` 已用 `tar::Builder` + `start_exec` 自带同等能力
（注入到 `/workspace`）。经代码勘察（`dual/` 无任何 `crate::pool` 引用），pool 三个
文件均无其他消费者。

- **备选**：把 `copy.rs` / `exec.rs` 上移到 `sandbox/` 供 dual 复用 —— 无消费者，
  属于为删除而迁移，增加改动面，否决。

### D2：main.rs 移除 RPC 白名单拉取，`mq/rpc.rs` 方法保留

`main.rs` 中 `rpc_client.get_image_allowlist()` 的唯一用途是构造 `pool::AllowedImage`
并初始化池；回退路径也是 `config.pool.images`。移除池后该调用整体删除（含
`judge_id` 与 `RpcClient` 构造）。但 `mq/rpc.rs` 的 `RpcClient::get_image_allowlist`
与 `ImageAllowlist` 保留：

- 它们是 core↔judge RPC 协议的公共 API（`pub`，不触发 dead_code 警告），core 侧
  handler 仍提供服务，`judge-rpc` spec 仍有效。
- **备选**：一并删除 —— 会牵连 RPC 协议测试与 core 侧能力定义，超出容器池移除范围。

### D3：优雅关闭保留排空、移除池清理

`main.rs` 的 `ctrl_c` → `shutdown_rx` → `drain_tasks` → `break` 流程保留（in-flight
评测任务排空仍需），仅删除其中 `pool_ref.shutdown()` 调用与 `pool_ref` 持有。

### D4：依赖按编译结果清理

`gethostname` 仅用于 `judge_id`（RPC 标识），RPC 调用移除后需确认是否还有其他使用；
`filetime` 等可能仅被 pool 使用。实施时以 `cargo check` / `cargo clippy` 的
unused-dependencies 线索为准，手动核对 `Cargo.toml`，通过 `cargo update` 或直接
编辑移除（不手工改动 `Cargo.lock` 之外的元数据；`Cargo.lock` 由 cargo 重新生成）。

### D5：spec delta 采用"改写受影响 Requirement"策略

`judge-worker`（评测编排、临时文件管理）、`docker-sandbox`（容器创建模型）、
`judge-rpc`（预热场景）、`judge-image-whitelist`（分池预热语义）四处规范中的容器池
语义改为双容器即时创建模型；不新增 Requirement，仅更新既有文本。

## Risks / Trade-offs

- [误删 dual 路径依赖的公共能力] → 全量 `cargo test`（含 `--all-targets`）+ 关键
  E2E（`e2e_dual_container`）回归；`rg "pool|Pool" noj-judge/src` 验收无残留。
- [CI 分组遗漏导致 e2e.yml / ci.yml 不一致] → 两处工作流同步修改，注释中
  "6 个 e2e_* 测试文件" 同步改为 5 个；`judge-sandbox` job 实测一次。
- [文档残留（AGENTS.md / CLAUDE.md / noj-docs）] → 验收步骤全局
  `rg -n "容器池|POOL_|e2e_container_pool|PoolManager"`（排除 archive），逐处清零。
- [`POOL_*` 环境变量残留于部署环境不报错，造成"假配置"困惑] → 文档明确标注变量
  已废弃移除；judge 侧不再读取，无需兼容代码。
- [移除 RPC 调用后 core 侧 `get_image_allowlist` handler 成为无请求方] →
  保留（白名单仍用于题目创建校验等 core 侧逻辑），属预期状态，judge-image-whitelist
  spec 同步说明。

## Migration Plan

1. 删除 `src/pool/` 与 `tests/e2e_container_pool.rs`。
2. 修改 `main.rs` / `lib.rs` / `config.rs` 及三处注释。
3. 清理 `Cargo.toml` 中确无使用的依赖。
4. 更新 CI 两个工作流。
5. 更新 4 个 spec delta 与全部文档。
6. 验证：`cargo fmt` / `cargo clippy` / `cargo test --all-targets`（无 Docker 的单元
   测试全绿）；有 Docker 时跑 `e2e_dual_container` 回归。
7. 回滚策略：本次为纯删除变更，若出现回归，`git revert` 即恢复；无数据迁移、无
   部署顺序要求。

## Open Questions

- 无阻塞性问题。`mq/rpc.rs` 的 `get_image_allowlist` 保留为公共 API 的决定可在
  评审时确认（备选：标注 `#[allow(dead_code)]` 或删除）。
