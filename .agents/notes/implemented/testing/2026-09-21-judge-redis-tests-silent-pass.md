# Agent Note: judge 的 Redis 集成测试在连接失败时静默记为通过

Status: implemented

## Problem

`noj-judge/tests/user_claim_redis.rs` 的 `connect()` 用 `.ok()?` 链把**所有**
连接失败都转成 `None`：

```rust
redis::Client::open(url).ok()?
    .get_multiplexed_async_connection().await
    .ok()          // ← 连接被拒/超时同样返回 None
```

而 6 个用例都是：

```rust
let Some(mut conn) = connect().await else {
    eprintln!("跳过：未设置 REDIS_URL");
    return;         // cargo/nextest 记为 passed
};
```

于是跳过语义覆盖了两种完全不同的情况：

1. **未配置** `REDIS_URL`（本地无 Redis 时的显式跳过）——合理；
2. **配置了但连不上**（CI service 未起、端口写错、Redis 挂了）——应当失败，
   却被记为 `passed`，且打印的是误导性的"未设置 REDIS_URL"。

实测对照（同一条命令，仅端口不可达）：

| 状态 | 命令 | 结果 |
| --- | --- | --- |
| 修复前 | `REDIS_URL=redis://127.0.0.1:6398/9 cargo test --test user_claim_redis` | `7 passed; 0 failed` |
| 修复后 | 同上 | `FAILED. 1 passed; 6 failed` |

被吞掉的 6 个用例包含本仓库最关键的并发回归证据
`concurrent_claims_only_one_wins`（跨 worker 每用户互斥）。也就是说
**CI 基础设施故障会表现为绿色**，与该文件头部注释"这些用例在每次 CI 都真实
执行"的承诺相反。

## Decision

把"未配置"与"连不上"分开：

- `std::env::var("REDIS_URL")` 缺失 → 打印显著提示并 `return None`（跳过的
  唯一合法路径，语义不变）；
- **设置了** `REDIS_URL` → `Client::open` 与 `get_multiplexed_async_connection`
  的失败一律 `panic!`，错误信息包含实际 URL 与可操作提示（"本用例必须真实
  执行，不得记为 passed"）。

这样 CI 的 `judge-check`（已注入 Redis service 与 `REDIS_URL`）一旦 Redis
不可用会立即红灯，而不是静默放过。

## Alternatives considered

1. **用 `#[ignore]` 属性替代运行时跳过**：拒绝。`#[ignore]` 默认不运行，
   本地开发反而会失去"REDIS_URL 在就执行"的便利；且 CI 需显式
   `--include-ignored`，改动面更大。
2. **只对"未配置"打印提示、连不上仍然跳过但输出 warning**：拒绝。warning
   不会让 CI 失败，等于维持现状。
3. **引入 nextest 的 skip 机制**：拒绝（本轮）。仓库 CI 用 `cargo test`
   的兼容路径，且 `#[ignore]`/skip 的语义迁移会牵动所有 judge 测试的既有守卫
   约定，超出本次修复范围。

## Consequences

- 本地未设置 `REDIS_URL` 时行为不变（6 个用例跳过并打印提示）。
- 设置 `REDIS_URL` 后 Redis 不可达 → 测试失败，CI 不再假绿。
- 不改动 `noj-judge` 生产代码，仅测试基础设施。
