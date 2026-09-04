# noj-judge — Neuro OJ 评测 Worker

基于 **Rust + Docker** 的代码评测执行器。

## 职责

- 从 Redis MQ 拉取评测任务（Consumer）
- 在 Docker 容器中构建隔离的评测环境
- 执行用户提交的代码
- 限制资源使用（CPU、内存、时间、网络）
- 捕获执行输出并与预期输出对比
- 将评测结果返回给 noj-core

## 技术栈

| 组件         | 选择                       |
| ------------ | -------------------------- |
| 语言         | Rust (Edition 2021)        |
| 异步运行时   | Tokio                      |
| Redis 客户端 | redis-rs 0.27 (tokio-comp) |
| Docker API   | bollard 0.21               |
| 沙箱         | Docker 容器                |

## 目录结构

```
noj-judge/
├── Cargo.toml
├── Cargo.lock              # 版本锁定（提交到 git）
├── docker/                 # 评测镜像 Dockerfile
│   ├── evaluator-python/Dockerfile  # Evaluator Python 运行时（python:3.12-slim）
│   ├── solution-python/Dockerfile   # Solution Python 运行时（python:3.12-slim）
│   └── solution-ai/Dockerfile       # Solution AI 运行时（CPU torch/CV/ML）
├── Dockerfile.e2e          # E2E 测试用 Dockerfile（多阶段构建）
├── .dockerignore           # 排除 target/ tests/ docker/ 等
├── src/
│   ├── main.rs             # 入口（dual container 评测）
│   ├── lib.rs              # 库入口（暴露模块给集成测试）
│   ├── config.rs           # 环境变量配置
│   ├── types.rs            # JudgeTask、JudgeResult、CaseResult 类型
│   ├── drain.rs            # 优雅关闭时排空 in-flight 评测任务
│   ├── mq.rs               # Redis MQ 任务拉取 + 结果推送（带重试 + fallback）
│   ├── sandbox/
│   │   ├── mod.rs
│   │   ├── container.rs    # 容器生命周期 + zip 解压 + 命令解析
│   │   ├── download.rs     # noj-download:// 下载（base64 / s3 / local）
│   │   ├── cache.rs        # 内容寻址缓存
│   │   ├── cleanup.rs      # 孤儿容器清理
│   │   └── host_config.rs  # 容器 HostConfig 构造（安全项）
│   ├── judge/
│   │   ├── mod.rs
│   │   └── runner.rs       # 评测入口（支持包获取 + 双容器分发）
│   └── dual/
│       ├── mod.rs          # 双容器编排（Evaluator + Solution）
│       ├── container.rs    # 双容器生命周期
│       └── protocol.rs     # NDJSON 编排协议
└── tests/
    ├── common/mod.rs       # 测试公共辅助函数
    ├── e2e/
    │   ├── Dockerfile.test-runner  # 测试用 Python 镜像（DaoCloud 镜像源）
    │   └── evaluate.py     # 测试用评测脚本（支持 --hang/--memory-test 等标志）
    ├── e2e_docker_basic.rs
    ├── e2e_resource_limits.rs
    ├── e2e_security_isolation.rs
    ├── e2e_support_package.rs
    ├── e2e_dual_container.rs  # 双容器 NDJSON 编排 E2E
    ├── e2e_network_capability.rs  # evaluator 联网 + capability 转发 E2E
    └── e2e_problem_limits.rs  # 验证 time_limit_ms/memory_limit_mb 实际生效
```

## 开发命令

```bash
# 编译
cargo build

# 运行单元测试（推荐 cargo-nextest：并行执行多个 test binary，更快）
cargo nextest run --all-targets
# 或等价的 cargo test（无 doctest，覆盖相同）
cargo test

# 加速本地 Rust 编译（可选，强烈推荐）：
#   cargo install sccache --locked && export RUSTC_WRAPPER=sccache
# CI 已内置 mozilla/sccache-action（GHA cache backend），跨 run 复用编译产物

# 运行集成测试（需要 Docker daemon + NOJ_RUN_E2E=1）
NOJ_RUN_E2E=1 cargo test --test e2e_docker_basic -- --ignored
NOJ_RUN_E2E=1 cargo test --test e2e_resource_limits -- --ignored
NOJ_RUN_E2E=1 cargo test --test e2e_security_isolation -- --ignored
NOJ_RUN_E2E=1 cargo test --test e2e_support_package -- --ignored
NOJ_RUN_E2E=1 cargo test --test e2e_dual_container -- --ignored
NOJ_RUN_E2E=1 cargo test --test e2e_network_capability -- --ignored
NOJ_RUN_E2E=1 cargo test --test e2e_problem_limits -- --ignored

# 运行指定集成测试
NOJ_RUN_E2E=1 cargo test --test e2e_dual_container -- --ignored test_dual_container_basic

# 代码检查
cargo clippy

# 格式化
cargo fmt
```

> 集成测试需要 Docker daemon 运行中，且当前用户有权限访问
> `/var/run/docker.sock`。 每个集成测试是独立的 test binary，需分别指定
> `--test <name>`。 所有集成测试使用 `#[serial_test::serial]` 序列化执行，避免
> Docker 资源冲突。

## 环境变量

| 变量                      | 默认值               | 说明                                      |
| ------------------------- | -------------------- | ----------------------------------------- |
| `REDIS_URL`               | `redis://127.0.0.1/` | Redis 连接                                |
| `JUDGE_QUEUE`             | `noj:judge:queue`    | 评测任务队列名                            |
| `RESULT_QUEUE`            | `noj:judge:results`  | 评测结果队列名                            |
| `WORK_DIR`                | `/tmp/noj-judge`     | 临时工作目录                              |
| `JUDGE_MAX_CONCURRENT_JUDGES` | `2`             | 同时执行的评测任务数（有效范围 1-1024） |
| `JUDGE_CPU_LIMIT_MILLICORES` | `1000`          | 每个评测容器 CPU 上限（1000m = 1 核，有效范围 100-16000） |

> `POOL_*` 环境变量已随容器池移除（见 remove-container-pool 变更），不再被读取。

## 评测流程（核心，双容器）

> 所有评测统一走 `dual::evaluate_dual()`（Evaluator + Solution 双容器 NDJSON 编排），
> 旧的单容器路径已移除。核心流程（`src/dual/mod.rs`）：

```
任务到达
  │
  ├─ 0. 白名单复验（镜像前缀 JUDGE_IMAGE_PREFIX / 命令可执行文件白名单 / 网络开关）
  ├─ 1. 获取支持包 — 缓存优先 → 按 host 分派下载（仅 HTTPS，禁重定向）→ SHA-256 校验 → 写缓存（含 zip 路径穿越/实时解压限额）
  ├─ 2. 创建 Evaluator + Solution 两个容器（cap_drop ALL / network none 默认 / pids_limit / 可配置 CPU 上限 / readonly rootfs + tmpfs）
  ├─ 3. 注入用户代码/artifact zip 到 Solution 容器（artifact 模式解压到 /workspace，入口 submission.py）
  ├─ 4. 注入支持包 zip 到 Evaluator 容器 /workspace
  ├─ 5. 启动两个 exec — Evaluator 跑 evaluate.py；Solution 跑 host.py
  ├─ 6. 等待 Solution `ready` 帧（5s 超时）
  ├─ 7. 双向消息转发 — evaluator stdout ↔ solution stdin/stderr（调用级超时）
  │     ├─ 超时 → 向等待方写入 CallTimeout/error 帧
  │     └─ 正常 → 读取 stdout/stderr 直到 RESULT 或 EOF
  ├─ 8. 等待 Evaluator stdout 出现 ---RESULT--- 标记，解析 JSON {score, details}
  │     ├─ 有标记 → 统一映射 finished/error（分数是唯一结果）
  │     ├─ 总超时（启动超时 / time_limit_ms）→ SystemError（finalize_outcome 优先）
  │     ├─ 无标记 + 曾发送 CallTimeout 错误帧 → TimeLimitExceeded
  │     └─ 无标记 + 未发送 → SystemError
  └─ 9. 发 `shutdown` 到 Solution → 显式 `dual.destroy()` 清理两个容器
```

当前实现回填 `time_ms`（从评测开始到结果生成的墙上时钟耗时）；
`memory_kb` 通过销毁前读取一次 Docker stats 尽力回填：
- cgroups v1 使用 `memory_stats.max_usage`（真实峰值）；
- cgroups v2 无 `max_usage` 时回退到 `usage`（近似值）；
- 读取失败或容器不可用时保持 `null`（不阻断评测）。

OOM 容器由 `docker rm -f` 回收；当前仍不单独映射 `MemoryLimitExceeded`
（Solution OOM 由 evaluator/超时路径归因）。

### 超时处理细节

- 判定超时阈值 = `time_limit_ms`
- 超时由 judge 内部 deadline 判定（启动 30s / 题目 `time_limit_ms` / 调用级 `call_timeout_ms`）
- 超时后通过 `dual.destroy()` 的 `docker rm -f` 强制清理容器
- 状态由 `finalize_outcome` 按超时来源与 CallTimeout 归因决定（总超时 → SystemError；仅调用级 CallTimeout → TLE）
- 输出从 Bollard exec 流实时收集（非 `docker logs`）

## MQ 消息格式

**JudgeTask（noj-core → noj-judge）**：

```json
{
  "submission_id": "uuid",
  "problem_id": "uuid",
  "download_url": "noj-download://base64/?content=UEsDBBQAAAAIA...&checksum_sha256=abc123",
  "artifact_download_url": "noj-download://s3?url=...&checksum_sha256=abc123",
  "runtime_config": {
    "evaluator": {
      "image": "noj-evaluator-python",
      "command": "python3 /workspace/evaluate.py",
      "time_limit_ms": 5000,
      "memory_limit_mb": 512
    },
    "solution": {
      "image": "noj-solution-python",
      "call_timeout_ms": 2000,
      "memory_limit_mb": 512
    }
  },
  "language": "python3",
  "code": "...",
  "file_name": "submission.py",
  "rejudge_seq": 1
}
```

> 双容器架构后 `judge_image` / `judge_command` / `time_limit_ms` / `memory_limit_mb`
> 顶层字段已移除，统一由 `runtime_config`（Evaluator + Solution）承载。

**JudgeResult（noj-judge → noj-core）**：

```json
{
  "submission_id": "uuid",
  "status": "finished",
  "score": 1000,
  "output": "---RESULT---\n{\"score\":1000,\"details\":{}}",
  "details": { "cases": [...] },
  "time_ms": 42,
  "memory_kb": null
}
```

## 关键安全措施

- **zip 路径穿越防护**：拒绝含 `..` 或 `/` 开头的 zip 条目
- **zip 炸弹防护**：最大条目数 1000、单文件 64MB、总解压
  512MB（硬编码；按实际解压字节实时限额，不信任条目声明大小）
- **文件名安全**：拒绝含 `/`、`\`、`..` 的文件名
- **容器安全**：`cap_drop ALL`、`no-new-privileges`、`network_mode none`（默认）、`ipc_mode none`、`pids_limit 256`、CPU 上限、readonly rootfs + tmpfs /workspace
- **结果重试**：推送结果最多重试 3
  次（指数退避），全部失败则序列化到本地文件系统
- **孤儿容器清理**：启动时按标签清理残留容器
- **JudgeResult::error()** 有意隐藏错误详情（不暴露内部路径/配置给用户）
- **镜像存在性检查**：`ensure_image_local()` 检查本地是否存在，不存在则从
  registry 拉取

## 日志约定

- 使用 `tracing` crate 输出结构化日志
- 关键事件：任务到达、评测开始/完成、超时、OOM、容器状态变化

## 代码规范

- `cargo fmt` 格式化 + `cargo clippy`（禁止 warnings）
- 错误处理：`anyhow::Result` + `.context()`
- 日志：`tracing::info!` / `warn!` / `error!`
- 异步优先：所有 I/O 操作用 async/await
- `#[allow(dead_code)]` 合法使用位置：
  - `types.rs`：`CaseResult` 结构体字段
- `#[allow(unreachable_code)]`：`main.rs` 中 `rt.block_on` 后的
  `Ok(())`，属合法使用
- `#[ignore]`：集成测试，需要 `NOJ_RUN_E2E=1` + Docker 环境


## 测试基础设施

- 所有集成测试使用 `#[ignore]` + `NOJ_RUN_E2E=1` 守卫
- 使用 `#[serial_test::serial]` 序列化执行（避免 Docker 资源竞争）
- 30 秒外层超时：`tokio::time::timeout(Duration::from_secs(30), ...)`
- 测试用镜像：`noj-judge-test-runner`（基于
  `docker.m.daocloud.io/library/python:3.12-alpine`）
- 测试用 evaluate.py
  支持标志：`--hang`（死循环）、`--memory-test`（OOM）、`--no-result`、`--result-json`、`--exit-code`
- 测试镜像通过 docker CLI 子进程构建（bollard tar 构建在测试环境中不可靠）

## Docker 构建

**Evaluator 镜像**（`docker/evaluator-python/Dockerfile`）：

- 基于 `python:3.12-slim`，无额外包
- 依赖由 evaluate.py 自身管理
- 本地构建：`docker build -t noj-evaluator-python -f docker/evaluator-python/Dockerfile .`

**Solution AI 镜像**（`docker/solution-ai/Dockerfile`）：

- 基于 `python:3.12-slim` + CPU 版 torch/torchvision + CV/ML 常用库 + noj_solution_sdk
- 供 artifact 题（CV/ML 小模型）推理使用
- 构建：`./scripts/build-sdk-images.sh`（同时构建 evaluator/solution/solution-ai）

**E2E 测试镜像**（`Dockerfile.e2e`）：

- 多阶段构建：BuildKit 缓存挂载编译 → debian:bookworm-slim 运行
- 用于在容器中运行 noj-judge 二进制本身

**.dockerignore**：排除
`target/`、`tests/`、`docker/`、`AGENTS.md`、`CLAUDE.md`（构建上下文从 800MB+
降至 ~200KB）

## 相关文档

- [Tokio 文档](https://tokio.rs/)
- [redis-rs 文档](https://docs.rs/redis/)
- [Docker Engine API](https://docs.docker.com/engine/api/)
- [bollard](https://docs.rs/bollard/)
