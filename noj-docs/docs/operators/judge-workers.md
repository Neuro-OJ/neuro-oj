# Judge Worker 运维

本文覆盖 noj-judge 的职责、运行时镜像、容器池、健康检查、队列监控、水平扩展与升级。

## Worker 职责

`noj-judge` 从 Redis 队列拉取评测任务，下载纯净评测包，创建或复用 Docker 容器，运行 evaluator，并把结果写回 Redis。

支持多个 Judge Worker 实例水平扩展：所有实例消费同一个 Redis 队列，互不冲突。

## 双容器运行时

默认 Python 题目使用两个镜像：

- `noj-evaluator-python`：运行出题人的 `evaluate.py`。
- `noj-solution-python`：运行用户提交的 `solution.py` 和 Solution Host。

Evaluator 容器可以通过 Neuro OJ Evaluator SDK 调用 Solution 容器中的用户函数。

### 构建评测镜像

构建脚本位于 `noj-judge/scripts/build-sdk-images.sh`：

```bash
cd noj-judge
./scripts/build-sdk-images.sh               # 构建两个镜像，默认 tag :latest
./scripts/build-sdk-images.sh --tag v0.1.0  # 自定义 tag
```

默认 `:latest` tag 与 noj-core 种子数据 `judge_images` 中登记的裸镜像名（`noj-evaluator-python` / `noj-solution-python`，docker 解析为 `:latest`）保持一致；自定义 tag 后需要同步更新 noj-core 的镜像白名单登记。

镜像基于 `python:3.12-slim`，不预装额外 Python 包，题目依赖由出题人在 evaluator 中自行管理。

## 镜像白名单

noj-core 维护评测镜像白名单（`judgeImages`）。Judge Worker 启动时会通过 Redis RPC 获取白名单，并只预热和使用允许的镜像。

镜像规则包含：

- `image`：镜像名。
- `kind`：`evaluator` 或 `solution`。
- `mode`：版本匹配模式。

新增或修改镜像后，需要在 noj-core 的白名单中登记，再重启 Judge Worker（或等待其重新拉取白名单）。

## 容器池

Judge Worker 使用容器池预热 evaluator 和 solution 容器。空闲容器会被复用；任务完成后池会回补容器。这样可以降低每次提交的冷启动成本。

池的关键行为：

- 启动时按 `POOL_INITIAL_SIZE` 预热每个白名单镜像的容器，池上限由 `POOL_MAX_SIZE` 控制。
- 空闲容器超过 `POOL_IDLE_TIMEOUT` 会被清理，任务高峰时懒回补。
- 定期健康检查空闲容器（硬编码 5s 间隔），异常容器会被替换。
- 容器内存硬上限由 `POOL_MEMORY_MB` 控制。

## 健康检查与状态查看

```bash
# 查看所有模块状态（含 judge 是否在线）
bash scripts/dev/devtool.sh status

# 结构化输出
bash scripts/dev/devtool.sh status --json
```

日志位置：

- `scripts/dev/logs/judge.log`（devtool.sh 启动时）
- 手动 `cargo run` 时直接看终端输出

调高日志详细度排查问题：

```bash
RUST_LOG=noj_judge=debug cargo run
```

## 队列监控 {#queue-monitoring}

评测任务在 Redis 队列 `noj:judge:queue` 中排队，结果写回 `noj:judge:results`：

```bash
# 查看积压任务数
redis-cli LLEN noj:judge:queue
```

如果队列持续堆积：

1. 确认 Judge Worker 在线且连接了同一个 Redis（`devtool.sh status`）。
2. 查看 judge 日志是否有拉取/容器错误。
3. 检查 Docker daemon 是否可用、镜像是否已构建。
4. 如负载确实超过单实例能力，按下一节水平扩展。

## 水平扩展

启动多个 noj-judge 实例即可分担负载：

- 每个实例独立维护自己的容器池，消费同一个 `noj:judge:queue`。
- 实例标识由 `JUDGE_ID`（默认主机名）区分，用于 Redis RPC 响应路由。
- 新实例启动后会自动拉取白名单并预热容器，无需额外注册。

## 升级与重启

- 停止实例会进入优雅关闭流程：排空正在执行的 in-flight 任务后再退出，避免提交丢失。
- 升级步骤：`devtool.sh stop judge` → 构建新版本（`cargo build --release`）或更新镜像 → `devtool.sh start judge`。
- 升级评测镜像后应先在 noj-core 白名单登记，再启动 Worker。

## 常见排查方向

- Redis 连接失败：检查 Redis 地址和服务状态。
- Docker 连接失败：确认 Docker daemon 可用，当前用户有权限访问。
- 镜像不存在：先执行 `noj-judge/scripts/build-sdk-images.sh` 构建 `noj-evaluator-python` 与 `noj-solution-python`。
- 白名单为空：确认 noj-core 已启动、`deno task dev-setup`（或 `init:system`）已执行，且 Judge Worker 能通过 Redis RPC 请求到白名单。
- `SystemError`：通常是纯净评测包、运行时配置、镜像、协议或 evaluator 本身异常，需要查看 Judge Worker 日志。
- 提交长时间 `Pending`：见上文「队列监控」。
