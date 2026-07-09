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
│   └── python/Dockerfile   # Python 评测运行时（python:3.12-slim）
├── Dockerfile.e2e          # E2E 测试用 Dockerfile（多阶段构建）
├── .dockerignore           # 排除 target/ tests/ docker/ 等
├── src/
│   ├── main.rs             # 入口（容器池模式）
│   ├── lib.rs              # 库入口（暴露模块给集成测试）
│   ├── config.rs           # 环境变量配置（PoolConfig + 全局配置）
│   ├── types.rs            # JudgeTask、JudgeResult、CaseResult 类型
│   ├── mq.rs               # Redis MQ 任务拉取 + 结果推送（带重试 + fallback）
│   ├── mq/
│   │   └── rpc.rs           # Redis RPC 客户端（core↔judge 通信）
│   ├── sandbox/
│   │   ├── mod.rs
│   │   └── container.rs    # 容器生命周期 + zip 解压 + 命令解析
│   ├── judge/
│   │   ├── mod.rs
│   │   └── runner.rs       # 评测逻辑（---RESULT--- 标记解析 + 超时/OOM 检测）
│   └── pool/
│       ├── mod.rs          # PoolManager（固定池，懒回补 + 健康检查）
│       ├── copy.rs         # tar 打包 + docker exec 注入文件
│       └── exec.rs         # docker exec 执行命令 + cgroup 内存峰值读取
└── tests/
    ├── common/mod.rs       # 测试公共辅助函数
    ├── e2e/
    │   ├── Dockerfile.test-runner  # 测试用 Python 镜像（DaoCloud 镜像源）
    │   └── evaluate.py     # 测试用评测脚本（支持 --hang/--memory-test 等标志）
    ├── e2e_docker_basic.rs
    ├── e2e_resource_limits.rs
    ├── e2e_security_isolation.rs
    ├── e2e_support_package.rs
    ├── e2e_container_pool.rs
    └── e2e_problem_limits.rs  # 验证 time_limit_ms/memory_limit_mb 实际生效
```

## 开发命令

```bash
# 编译
cargo build

# 运行单元测试
cargo test --lib

# 运行集成测试（需要 Docker daemon + NOJ_RUN_E2E=1）
NOJ_RUN_E2E=1 cargo test --test e2e_docker_basic -- --ignored
NOJ_RUN_E2E=1 cargo test --test e2e_resource_limits -- --ignored
NOJ_RUN_E2E=1 cargo test --test e2e_security_isolation -- --ignored
NOJ_RUN_E2E=1 cargo test --test e2e_support_package -- --ignored
NOJ_RUN_E2E=1 cargo test --test e2e_container_pool -- --ignored
NOJ_RUN_E2E=1 cargo test --test e2e_problem_limits -- --ignored

# 运行指定集成测试
NOJ_RUN_E2E=1 cargo test --test e2e_container_pool -- --ignored test_container_lifecycle

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
| `POOL_INITIAL_SIZE`       | `2`                  | 每镜像预热容器数                          |
| `POOL_MAX_SIZE`           | `16`                 | 池最大深度                                |
| `POOL_MIN_SIZE`           | `1`                  | 池最小深度                                |
| `POOL_MEMORY_MB`          | `256`                | 容器内存硬上限（MB）                      |
| `POOL_CPU`                | `0`                  | CPU 核数（0=无限制）                      |
| `POOL_IDLE_TIMEOUT`       | `300`                | 空闲容器超时秒数                          |
| `POOL_MAX_ARCHIVE_MB`     | `25`                 | 支持包最大 MB                             |
| `POOL_KILL_GRACE_SECONDS` | `2`                  | SIGTERM→SIGKILL 等待秒数                  |
| `POOL_LABEL_PREFIX`       | `com.noj.judge`      | Docker 容器标签前缀                       |
| `JUDGE_ID`                | hostname             | Judge 实例标识（用于 Redis RPC 响应队列） |

### 池内部常量（硬编码，不可配置）

| 常量          | 值                     | 说明                                |
| ------------- | ---------------------- | ----------------------------------- |
| 健康检查间隔  | 5s                     | `start_health_check()` 轮询空闲容器 |
| 容器 rm 重试  | 3 次（100ms/500ms/2s） | 清理容器时的退避重试                |
| Exec 创建超时 | 10s                    | Docker daemon 响应超时              |
| 内存读取超时  | 5s                     | cgroup 峰值读取超时                 |

## 容器池架构（单一模式）

noj-judge 始终使用容器池模式，无 Semaphore 退化路径。

```
主流程:
  RPC 启动 → 通过 Redis RPC 从 core 获取镜像白名单
  → PoolManager::init(images) → 预创建 POOL_INITIAL_SIZE 个容器/每个镜像
  → start_background_tasks()
      └─ start_health_check() — 每 5s 检查空闲容器状态 + 每 30s 输出池指标日志

评测流程:
  with_container(image, memory_mb, closure)
   → acquire_with_pool()
       ├─ 快速路径: idle.pop_front() — 从空闲队列取
       └─ 慢路径: create_container() — 即时创建新容器
   → evaluate_with_pool() → archive_and_copy() → execute_in_container()
   → read_memory_peak_kb() → process_output()
   → release()
       ├─ docker rm -f (3次重试)
       └─ 创建新容器回补到空闲队列
```

## 评测流程（核心）

```
任务到达
  │
  ├─ 1. get_support_package_bytes() — Base64 解码支持包 zip
  ├─ 2. extract_zip() — 解压到工作目录（含路径穿越防护）
  ├─ 3. write_user_code() — 写入用户代码（文件名安全校验）
  ├─ 4. archive_and_copy() — tar 打包 + docker exec tar xf 注入容器
  ├─ 5. execute_in_container() — 执行评测命令（竞速超时）
  │     ├─ 超时 → stop_container(SIGTERM) + kill_container(SIGKILL) → exit_code = -1
  │     │   └─ 超时后从 docker logs 捕获剩余输出
  │     └─ 正常 → 读取 stdout/stderr + exit_code
  ├─ 6. read_memory_peak_kb() — 读取 cgroup 内存峰值
  │     ├─ cgroup v2: /sys/fs/cgroup/memory.peak
  │     ├─ cgroup v1: /sys/fs/cgroup/memory/memory.max_usage_in_bytes
  │     └─ fallback: echo 0
  └─ 7. process_output() — 解析 ---RESULT--- 标记
        ├─ 有标记 → 解析 JSON {status, score, details}
        ├─ 无标记 + exit 0 → SystemError
        ├─ 无标记 + exit ≠ 0 → RuntimeError
        ├─ exit = -1 → TimeLimitExceeded
        └─ exit = 137 → MemoryLimitExceeded
```

### 超时处理细节

- 判定超时阈值 = `time_limit_ms`
- 超时后两步终止：先 `stop_container(t: kill_grace_secs)` 发 SIGTERM，再
  `kill_container()` 发 SIGKILL
- 超时后从 `docker logs` 捕获已产生的输出（`follow: false`）
- 超时退出码固定为 `-1`（即使容器后来报告不同退出码）
- 内存峰值读取使用相同 exec 基础设施，5s 超时 + 2s kill grace

## MQ 消息格式

**JudgeTask（noj-core → noj-judge）**：

```json
{
  "submission_id": "uuid",
  "problem_id": "1001",
  "judge_image": "noj-judge-python",
  "judge_command": "python3 /tmp/evaluate.py",
  "download_url": "noj-download://base64/?content=UEsDBBQAAAAIA...&checksum_sha256=abc123",
  "language": "python3",
  "code": "...",
  "file_name": "submission.py",
  "time_limit_ms": 5000,
  "memory_limit_mb": 512
}
```

**JudgeResult（noj-judge → noj-core）**：

```json
{
  "submission_id": "uuid",
  "status": "Accepted",
  "score": 1000,
  "output": "---RESULT---\n{\"status\":\"Accepted\",\"score\":1000,\"details\":{}}",
  "details": { "cases": [...] },
  "time_ms": 42,
  "memory_kb": 8192
}
```

## 关键安全措施

- **zip 路径穿越防护**：拒绝含 `..` 或 `/` 开头的 zip 条目
- **zip 炸弹防护**：最大条目数 1000、单文件 64MB、总解压
  512MB（硬编码，不可配置）
- **文件名安全**：拒绝含 `/`、`\`、`..` 的文件名
- **容器安全**：`cap_drop ALL`、`no-new-privileges`、`network_mode none`、`ipc_mode none`、`pids_limit 256`
- **结果重试**：推送结果最多重试 3
  次（指数退避），全部失败则序列化到本地文件系统
- **孤儿容器清理**：启动时按标签清理残留容器
- **JudgeResult::error()** 有意隐藏错误详情（不暴露内部路径/配置给用户）
- **镜像存在性检查**：`ensure_image_local()` 检查本地是否存在，不存在则从
  registry 拉取

## 日志约定

- 使用 `tracing` crate 输出结构化日志
- 关键事件：任务到达、评测开始/完成、超时、OOM、池状态变化

## 池指标日志

池状态通过 tracing 日志输出（每 30s），无独立的 Prometheus 端点：

```text
pool_status=true image=noj-judge-python idle=2 in_flight=1 total=3 min=1 max=16
```

指标包括：`idle`（空闲容器数）、`in_flight`（运行中任务数）、`total`（总容器数）、`min`/`max`（池边界）。

## 代码规范

- `cargo fmt` 格式化 + `cargo clippy`（禁止 warnings）
- 错误处理：`anyhow::Result` + `.context()`
- 日志：`tracing::info!` / `warn!` / `error!`
- 异步优先：所有 I/O 操作用 async/await
- `#[allow(dead_code)]` 合法使用位置：
  - `pool/mod.rs`：`tasks_total()`、`errors_total()`、`timeouts_total()`、`all_pools()`、`get_pool()`、`is_shutting_down()`
  - `mq/rpc.rs`：`judge_id()`
  - `types.rs`：`CaseResult` 结构体字段
- `#[allow(unreachable_code)]`：`main.rs` 中 `rt.block_on` 后的
  `Ok(())`，属合法使用
- `#[ignore]`：集成测试，需要 `NOJ_RUN_E2E=1` + Docker 环境

## Redis RPC 通信

noj-judge 通过 Redis RPC 与 noj-core 通信，用于启动时获取镜像白名单。

### 协议

| 队列                                   | 方向         | 说明          |
| -------------------------------------- | ------------ | ------------- |
| `noj:rpc:v1:judge:core`                | judge → core | 请求（LPUSH） |
| `noj:rpc:v1:judge:{judge_id}:response` | core → judge | 响应（BRPOP） |

### 消息格式

**请求**：

```json
{
  "id": "<uuid>",
  "method": "get_image_allowlist",
  "params": null,
  "timestamp": 1767312345
}
```

**响应**：

```json
{
  "id": "<uuid>",
  "result": { "images": ["noj-judge-python"] },
  "error": null,
  "timestamp": 1767312346
}
```

### 镜像发现流程

```
noj-judge 启动
  → Redis RPC get_image_allowlist()
      ├─ 成功 → 从返回列表预热容器
      └─ 失败/超时 → error! 日志 + process::exit(1)（fail-fast）
  → PoolManager::init(images)
```

## 测试基础设施

- 所有集成测试使用 `#[ignore]` + `NOJ_RUN_E2E=1` 守卫
- 使用 `#[serial_test::serial]` 序列化执行（避免 Docker 资源竞争）
- 30 秒外层超时：`tokio::time::timeout(Duration::from_secs(30), ...)`
- 测试用镜像：`noj-judge-test-runner`（基于
  `docker.m.daocloud.io/library/python:3.12-alpine`）
- 测试用 evaluate.py
  支持标志：`--hang`（死循环）、`--memory-test`（OOM）、`--no-result`、`--result-json`、`--exit-code`
- 池测试使用独立标签前缀 `com.noj.judge.test` 避免与生产容器冲突
- 测试镜像通过 docker CLI 子进程构建（bollard tar 构建在测试环境中不可靠）

## Docker 构建

**评测镜像**（`docker/python/Dockerfile`）：

- 基于 `python:3.12-slim`，无额外包
- 依赖由 evaluate.py 自身管理
- 本地构建：`docker build -t noj-judge-python docker/python/`

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
