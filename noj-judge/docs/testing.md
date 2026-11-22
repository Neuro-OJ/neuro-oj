# 测试命令矩阵与 E2E 清单

> 硬约束（`NOJ_RUN_E2E=1` + Docker）见 [../AGENTS.md](../AGENTS.md)。流程细节见
> [flow.md](flow.md)。

## 1. 单元测试 / 编译

```bash
cargo build
cargo nextest run --all-targets      # 推荐：并行跑多个 test binary
cargo test                           # 等价（无 doctest）
```

本地加速（可选）：`cargo install sccache --locked && export RUSTC_WRAPPER=sccache`；
CI 已内置 `mozilla/sccache-action`（GHA cache backend），跨 run 复用编译产物。

## 2. 集成（Docker）E2E

每个 `tests/e2e_*.rs` 是独立 test binary，必须 `--test <name>` 指定，并带
`#[ignore]` + `#[serial_test::serial]`：

```bash
NOJ_RUN_E2E=1 cargo test --test e2e_docker_basic -- --ignored --test-threads=1
NOJ_RUN_E2E=1 cargo test --test e2e_dual_container -- --ignored dual_basic_call_round_trip
```

前置：Docker daemon 在跑，且当前用户能访问 `/var/run/docker.sock`。

## 3. CI 目标清单（分组即并行度）

| 组 | 目标                                                                          |
| -- | ----------------------------------------------------------------------------- |
| p1 | `e2e_docker_basic` `e2e_resource_limits` `e2e_security_isolation`             |
| p2 | `e2e_support_package` `e2e_problem_limits` `e2e_oi_native`                    |
| p3 | `e2e_dual_container` `e2e_network_capability` `e2e_abnormal` `e2e_prediction` |
| p4 | `e2e_solution_ai`                                                             |

- 会创建 dual（evaluator + solution）标签容器的用例集中在 p3：组间并行时它们会
  污染别组对全局 Docker 标签的轮询断言。
- 新增 `tests/e2e_*.rs` 必须同时登记进
  [`.github/workflows/e2e.yml`](../../.github/workflows/e2e.yml)，否则只编译不执行。
- 同一 binary 内靠 `serial_test` 串行，组内靠 `--test-threads=1` 串行。

## 4. 非 Docker 的 Rust 测试

| 文件                                                  | 内容                                        |
| ----------------------------------------------------- | ------------------------------------------- |
| `tests/judge_task_contract.rs`                        | JudgeTask wire 契约快照                     |
| `tests/judge_result_contract.rs`                      | JudgeResult wire 字段集合（含协议 v3 封套） |
| `tests/prediction_units.rs`                           | prediction 结果解析单元测试                 |
| `tests/oi_model.rs`                                   | OI 题目模型                                 |
| `tests/user_claim_redis.rs`、`tests/requeue_redis.rs` | 需 Redis 的 claim / 重投                    |

## 5. 测试设施约定

- 所有集成测试：`#[ignore]` + `NOJ_RUN_E2E=1` 守卫，`#[serial_test::serial]`
  序列化执行（避免 Docker 资源竞争）
- 30 秒外层超时：`tokio::time::timeout(Duration::from_secs(30), ...)`
- 测试用镜像 `noj-judge-test-runner`：基于 `python:3.12-alpine`，digest 固定；
  基础镜像仓库默认 DaoCloud 代理 `docker.m.daocloud.io/library/python`，可用
  `NOJ_E2E_PYTHON_IMAGE_REPO` 覆盖（CI 设为 `python` 直连 Docker Hub）
- 测试镜像通过 docker CLI 子进程构建（bollard tar 构建在测试环境中不可靠）
- `tests/e2e/evaluate.py` 支持标志：`--hang`（死循环）、`--memory-test`（OOM）、
  `--no-result`、`--result-json`、`--exit-code`

## 6. CI 门禁（judge 相关）

```bash
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo nextest run --locked --all-targets
NOJ_RUN_E2E=1 cargo test --locked --test <target> -- --ignored --test-threads=1
```

E2E job 另跑
`python3 -m unittest discover -s noj-judge/scripts -p 'test_ci_*.py'` （WASI
工具链与沙箱脚本自检），失败时上传 `target/**/test-*.log`。
