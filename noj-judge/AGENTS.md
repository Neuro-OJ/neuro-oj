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

| 组件         | 选择                          |
| ------------ | ----------------------------- |
| 语言         | Rust (Edition 2021)           |
| 异步运行时   | Tokio                         |
| Redis 客户端 | redis-rs 0.27 (tokio-comp)    |
| Docker API   | bollard 0.21                  |
| HTTP 服务    | axum 0.8（仅 metrics 端点）    |
| 沙箱         | Docker 容器                   |

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
│   ├── main.rs             # 入口（双模式：Pool / Semaphore）
│   ├── lib.rs              # 库入口（暴露模块给集成测试）
│   ├── config.rs           # 环境变量配置（PoolConfig + 全局配置）
│   ├── types.rs            # JudgeTask、JudgeResult、CaseResult 类型
│   ├── mq.rs               # Redis MQ 任务拉取 + 结果推送（带重试 + fallback）
│   ├── sandbox/
│   │   ├── mod.rs
│   │   └── container.rs    # 容器生命周期 + zip 解压 + 命令解析
│   ├── judge/
│   │   ├── mod.rs
│   │   └── runner.rs       # 评测逻辑（---RESULT--- 标记解析 + 超时/OOM 检测）
│   └── pool/
│       ├── mod.rs          # PoolManager（容器池 + RAII Guard + 健康检查）
│       ├── copy.rs         # tar 打包 + docker exec 注入文件
│       ├── exec.rs         # docker exec 执行命令 + cgroup 内存峰值读取
│       ├── metrics.rs      # Prometheus /metrics HTTP 端点
│       └── scaler.rs       # 自动扩缩容（滑动窗口 QPS + 排队时间）
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

> 集成测试需要 Docker daemon 运行中，且当前用户有权限访问 `/var/run/docker.sock`。
> 每个集成测试是独立的 test binary，需分别指定 `--test <name>`。
> 所有集成测试使用 `#[serial_test::serial]` 序列化执行，避免 Docker 资源冲突。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `REDIS_URL` | `redis://127.0.0.1/` | Redis 连接 |
| `JUDGE_QUEUE` | `noj:judge:queue` | 评测任务队列名 |
| `RESULT_QUEUE` | `noj:judge:results` | 评测结果队列名 |
| `WORK_DIR` | `/tmp/noj-judge` | 临时工作目录 |
| `MAX_CONCURRENT` | `2` | 并发上限（Semaphore 模式） |
| `POOL_ENABLED` | `true` | 是否启用容器池 |
| `POOL_INITIAL_SIZE` | `2` | 每镜像预热容器数 |
| `POOL_MAX_SIZE` | `16` | 池最大深度 |
| `POOL_MIN_SIZE` | `1` | 池最小深度 |
| `POOL_MEMORY_MB` | `256` | 容器内存硬上限（MB） |
| `POOL_CPU` | `0` | CPU 核数（0=无限制） |
| `POOL_IMAGES` | `noj-judge-python` | 预热镜像列表（逗号分隔） |
| `POOL_IDLE_TIMEOUT` | `300` | 空闲容器超时秒数 |
| `POOL_SCALE_INTERVAL` | `60` | 扩缩容评估间隔秒数 |
| `POOL_MAX_ARCHIVE_MB` | `25` | 支持包最大 MB |
| `POOL_KILL_GRACE_SECONDS` | `2` | SIGTERM→SIGKILL 等待秒数 |
| `POOL_LABEL_PREFIX` | `com.noj.judge` | Docker 容器标签前缀 |
| `METRICS_BIND` | `127.0.0.1:9100` | Metrics HTTP 监听地址 |
| `METRICS_AUTH_TOKEN` | — | Metrics 端点 Bearer token |

Per-image 内存配置：`POOL_MEMORY_MB_{IMAGE_NAME}`（镜像名大写，`-` 替换为 `_`）

### 池内部常量（硬编码，不可配置）

| 常量 | 值 | 说明 |
|------|-----|------|
| 健康检查间隔 | 5s | `start_health_check()` 轮询空闲容器 |
| Supervisor 间隔 | 30s | 输出池指标日志 |
| Refill 防抖 | 200ms | 容器释放后延迟再填充，避免抖动 |
| Acquire 超时 | 60s | 等待容器最大时间 |
| 容器 rm 重试 | 3 次（100ms/200ms/400ms） | 清理容器时的退避重试 |
| Exec 创建超时 | 10s | Docker daemon 响应超时 |
| 内存读取超时 | 5s | cgroup 峰值读取超时 |

## 双运行模式

### 1. 容器池模式（默认，`POOL_ENABLED=true`）

```
main.rs → PoolManager::init() → 预创建容器 → start_background_tasks()
  ├─ start_health_check()    — 每 5s 检查空闲容器状态
  ├─ start_supervisor()      — 每 30s 输出池指标
  ├─ start_scaler()          — 基于滑动窗口指标自动扩缩容
  └─ start_metrics_server() — Prometheus /metrics 端点

评测流程：
  acquire_guarded() → 从池获取空闲容器（或即时创建）
  → evaluate_with_pool() → archive_and_copy() → execute_in_container()
  → read_memory_peak_kb() → release()
```

### 2. Semaphore 模式（`POOL_ENABLED=false`）

```
Semaphore::new(max_concurrent) → 每次任务获取 permit
→ evaluate_legacy() → run_in_container() → 创建/启动/等待/清理容器
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

- 总超时时间 = `time_limit_ms + kill_grace_secs × 1000`（任务时限 + 宽限期）
- 超时后两步终止：先 `stop_container(t: kill_grace_secs)` 发 SIGTERM，再 `kill_container()` 发 SIGKILL
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
  "support_package_base64": "UEsDBBQAAAAIA...",
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
- **zip 炸弹防护**：最大条目数 1000、单文件 64MB、总解压 512MB（硬编码，不可配置）
- **文件名安全**：拒绝含 `/`、`\`、`..` 的文件名
- **容器安全**：`cap_drop ALL`、`no-new-privileges`、`network_mode none`、`ipc_mode none`、`pids_limit 256`
- **结果重试**：推送结果最多重试 3 次（指数退避），全部失败则序列化到本地文件系统
- **孤儿容器清理**：启动时按标签清理残留容器
- **JudgeResult::error()** 有意隐藏错误详情（不暴露内部路径/配置给用户）
- **评测镜像本地构建**：`ensure_image_local()` 明确要求镜像预先 `docker build`，不从 registry 拉取

## 日志约定

- 使用 `tracing` crate 输出结构化日志
- 关键事件：任务到达、评测开始/完成、超时、OOM、池状态变化

## Metrics 端点（Prometheus 格式）

监听 `GET /metrics`（`METRICS_BIND` 配置地址）。

| 指标 | 类型 | 说明 |
|------|------|------|
| `noj_judge_tasks_total` | Counter | 总任务数 |
| `noj_judge_errors_total` | Counter | 总错误数 |
| `noj_judge_timeouts_total` | Counter | 总超时数 |
| `noj_judge_pool_misses_total` | Counter | 池未命中数（需即时创建容器） |
| `noj_pool_idle_containers` | Gauge(镜像标签) | 空闲容器数 |
| `noj_pool_in_flight` | Gauge(镜像标签) | 运行中任务数 |
| `noj_pool_total_containers` | Gauge(镜像标签) | 总容器数 |
| `noj_pool_target_depth` | Gauge(镜像标签) | 目标池深度 |
| `noj_pool_leaked_containers` | Gauge | 无法清理的残留容器数 |

**实现细节**：
- 手写 Prometheus 文本格式（未使用 `prometheus` crate）
- 镜像标签中的 `\` 和 `"` 被转义
- 认证：`METRICS_AUTH_TOKEN` 为空时跳过鉴权
- 绑定失败仅记录日志，不阻止进程启动
- 无 `/health` 或 `/ready` 端点

## 代码规范

- `cargo fmt` 格式化 + `cargo clippy`（禁止 warnings）
- 错误处理：`anyhow::Result` + `.context()`
- 日志：`tracing::info!` / `warn!` / `error!`
- 异步优先：所有 I/O 操作用 async/await
- `#[allow(dead_code)]` 合法使用位置：
  - `pool/mod.rs`：`len()`、`is_empty()`、`total_containers()`、`snapshot()`、`collect_dead()`、`collect_idle_timeout()`
  - `pool/scaler.rs`：`start()` 通过 `tokio::spawn` 间接分发
  - `pool/metrics.rs`：`start_metrics_server()`、`metrics_handler()` 通过 `tokio::spawn` 间接分发
  - `types.rs`：`CaseResult` 结构体字段
  - `config.rs`：`idle_timeout_secs`、`scale_interval_secs`
  - `mq.rs`：`push_result()` 通过 `tokio::spawn` 间接分发
- `#[allow(unreachable_code)]`：`main.rs` 中 `rt.block_on` 后的 `Ok(())`，属合法使用
- `#[ignore]`：集成测试，需要 `NOJ_RUN_E2E=1` + Docker 环境

## 自动扩缩容算法（Scaler）

**评估周期**：`POOL_SCALE_INTERVAL`（默认 60s），滑动窗口为 1.5 倍周期（90s）

**扩容评分**（任一条件触发）：
| 条件 | 分值 |
|------|------|
| 平均排队等待 > 1000ms | +2 |
| 平均排队等待 > 500ms | +1 |
| Miss 率 > 30%（池空需即时创建） | +1 |

**缩容评分**（仅当扩容分为 0 时评估）：
| 条件 | 分值 |
|------|------|
| 空闲率 > 40% 持续 2+ 周期 | -1 |
| 空闲率 > 60% 持续 3+ 周期 | -1（额外） |

**目标值调整**：`new_target = (target + scale_up - scale_down).clamp(min_size, max_size)`

**事件驱动**：Scaler 接收 `Arrival`/`QueueWait`/`Miss` 事件，结合池快照做决策。
周期计数器（miss_count、sample_count）每周期重置。

## 测试基础设施

- 所有集成测试使用 `#[ignore]` + `NOJ_RUN_E2E=1` 守卫
- 使用 `#[serial_test::serial]` 序列化执行（避免 Docker 资源竞争）
- 30 秒外层超时：`tokio::time::timeout(Duration::from_secs(30), ...)`
- 测试用镜像：`noj-judge-test-runner`（基于 `docker.m.daocloud.io/library/python:3.12-alpine`）
- 测试用 evaluate.py 支持标志：`--hang`（死循环）、`--memory-test`（OOM）、`--no-result`、`--result-json`、`--exit-code`
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

**.dockerignore**：排除 `target/`、`tests/`、`docker/`、`AGENTS.md`、`CLAUDE.md`（构建上下文从 800MB+ 降至 ~200KB）

## 相关文档

- [Tokio 文档](https://tokio.rs/)
- [redis-rs 文档](https://docs.rs/redis/)
- [Docker Engine API](https://docs.docker.com/engine/api/)
- [bollard](https://docs.rs/bollard/)
