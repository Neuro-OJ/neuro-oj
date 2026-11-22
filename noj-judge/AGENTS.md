# noj-judge — Neuro OJ 评测 Worker

> Rust + Tokio + Docker 的评测执行器（双容器 Evaluator + Solution）。本文件只放
> **禁令 / 命令 / 路由**；细节从 [docs/flow.md](docs/flow.md) 进。

## 禁令

1. `cargo fmt` + `cargo clippy` 必须零警告。CI 跑 `cargo fmt --all --check` 与
   `cargo clippy --locked --all-targets -- -D warnings`，提交前本地先过一遍。
2. 集成测试必须有 Docker daemon + `NOJ_RUN_E2E=1`；未设该变量时 `#[ignore]` 用例
   只是被跳过，不得当作"已通过"。
3. 容器安全项禁止放宽：`cap_drop ALL`、`no-new-privileges`、`network_mode none`
   （默认）、`ipc_mode none`、`pids_limit 256`、readonly rootfs + tmpfs、
   Evaluator 网络禁 `bridge` / `host`。
4. zip 防护禁止放宽：拒绝 `..` 与 `/` 开头的条目；1000 条目 / 单文件 64MB /
   总解压 512MB 按**实际解压字节**实时限额，不信任条目声明大小。
5. 非法评分禁止 clamp、禁止 `unwrap_or(0)`：缺 `score`、非整数、越界一律转
   `result_kind=platform_error`，绝不当成 0 分 / 满分覆盖已有成绩。
6. wire 契约以
   [`noj-tests/fixtures/judge-task.contract.json`](../noj-tests/fixtures/judge-task.contract.json)
   为准，不得改字段名或语义；结果字段由
   [`tests/judge_result_contract.rs`](tests/judge_result_contract.rs) 钉住。
7. 协议 v3 字段（`run_id` / `attempt_id` / `problem_version_id` /
   `result_kind`） 只走可信封套，禁止写进 evaluator 可控的 `details`。
8. 支持包获取或 SHA-256 校验失败必须终止任务，禁止静默放行空环境。
9. 错误处理用 `anyhow::Result` + `.context()`，日志用 `tracing::info!` / `warn!`
   / `error!` 宏，I/O 一律 async。`#[allow(dead_code)]` 只允许在 `types.rs` 的
   `CaseResult` 字段；`#[allow(unreachable_code)]` 只允许在 `main.rs`
   `rt.block_on` 之后的 `Ok(())`。
10. 新增环境变量必须同时更新 `docs/env*.md` 与 `.env.example`；`Cargo.lock`
    不手改。

## 命令

```bash
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo nextest run --locked --all-targets          # 或 cargo test
NOJ_RUN_E2E=1 cargo test --test e2e_dual_container -- --ignored --test-threads=1
./scripts/build-sdk-images.sh
docker build -t noj-evaluator-python -f docker/evaluator-python/Dockerfile .
```

全部 E2E 目标与 CI 分组见 [docs/testing.md](docs/testing.md)。

## 路由

| 想找                                       | 看                                       |
| ------------------------------------------ | ---------------------------------------- |
| 通用环境变量全表                           | [docs/env.md](docs/env.md)               |
| OI / go-judge / WASI 变量与工具链          | [docs/env-oi.md](docs/env-oi.md)         |
| 容器安全项、zip 防护、镜像与支持包缓存     | [docs/sandbox.md](docs/sandbox.md)       |
| wire 契约、协议 v3 封套、结果字段语义      | [docs/protocol.md](docs/protocol.md)     |
| 职责、技术栈、双容器主流程、超时归属       | [docs/flow.md](docs/flow.md)             |
| prediction 单容器流程                      | [docs/prediction.md](docs/prediction.md) |
| 测试命令矩阵、E2E 清单、测试设施           | [docs/testing.md](docs/testing.md)       |

## 模块坐标

| 入口                                             | 职责                                              |
| ------------------------------------------------ | ------------------------------------------------- |
| `src/main.rs`                                    | 启动、MQ 消费循环、推送前 `apply_protocol` 封套   |
| `src/judge/runner.rs`                            | 评测入口：支持包获取 + 双容器 / prediction 分发   |
| `src/dual/`                                      | 双容器编排、NDJSON 帧与管道、调用追踪             |
| `src/prediction/mod.rs`                          | prediction 单容器数据评分（无 Solution 容器）     |
| `src/sandbox/`                                   | 容器生命周期、HostConfig 安全项、下载、缓存、清扫 |
| `src/oi/`                                        | OI WASM / native 编译运行、go-judge 租约          |
| `src/mq.rs`、`src/user_claim.rs`、`src/drain.rs` | 拉取与重投、用户级 claim、优雅关闭排空            |
| `src/types.rs`、`src/config.rs`                  | wire 类型、环境变量解析                           |

## 外部约定

- 任务来源与结果消费方：noj-core（`JUDGE_QUEUE` / `RESULT_QUEUE` 两侧必须一致）
- 安全基线：
  [`dev-docs/engineering/defensive-patterns.md`](../dev-docs/engineering/defensive-patterns.md)、
  [`noj-docs/docs/system/security.md`](../noj-docs/docs/system/security.md)
- 参考：[Tokio](https://tokio.rs/)、[redis-rs](https://docs.rs/redis/)、
  [bollard](https://docs.rs/bollard/)、[Docker Engine API](https://docs.docker.com/engine/api/)
