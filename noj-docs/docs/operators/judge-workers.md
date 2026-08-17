# Judge Worker 运维

::: danger 文档状态：部署运维方案尚未成熟
本分区文档描述的是**开发期部署与运维方式**（手动分步启动、开发期脚本），**尚未提供面向生产的一键部署方案**——当前不具备守护进程管理、TLS、备份、升级等生产级能力，生产部署请谨慎参考。项目后续将提供成熟的一键部署方式，届时本文档将整体更新。
:::

本文覆盖 noj-judge 的职责、运行时镜像、评测流程、队列监控、水平扩展与升级。

## Worker 职责

`noj-judge` 从 Redis 队列拉取评测任务，下载纯净评测包，为每次评测即时创建
Evaluator + Solution 双容器（用后即毁），并把结果写回 Redis。

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

noj-core 维护评测镜像白名单（`judgeImages`），并在题目 CRUD / 调度阶段完成校验。Judge Worker 侧还会按 `JUDGE_IMAGE_PREFIX` / `JUDGE_COMMAND_WHITELIST` 对 MQ 消息做一次纵深复验，不再通过 Redis RPC 拉取白名单。

镜像规则包含：

- `image`：镜像名。
- `kind`：`evaluator` 或 `solution`。
- `mode`：版本匹配模式。

新增或修改镜像后，需要在 noj-core 的白名单中登记（镜像白名单校验在 core 侧
题目 CRUD 与调度阶段完成，judge 不再于启动时拉取）。

## 评测流程

每次提交评测按以下流程执行：

1. 从 Redis 队列拉取 JudgeTask。
2. 获取支持包（缓存优先 → 按 `noj-download://` host 分派下载 → SHA-256 校验）。
3. 为本次评测即时创建 Evaluator + Solution 两个容器（安全 HostConfig：
   `cap_drop ALL` / `network_mode none` / `pids_limit` 等）。
4. 注入用户代码与支持包，启动双容器 NDJSON 编排。
5. 评测完成后按 RAII 顺序清理容器（先 Solution 后 Evaluator），下次评测重新创建。

## 健康检查与状态查看

::: note 工具说明
以下 `devtool.sh` 命令来自开发期脚本（见[本地启动](local-start.md#开发期脚本-devtool-sh-不成熟)的警告），适合本地与开发环境；生产实例建议直接使用 docker / 进程管理工具查看状态。
:::

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

- 所有实例消费同一个 `noj:judge:queue`，互不冲突。
- 新实例启动后即可消费任务，无需额外注册。

## 升级与重启

- 停止实例会进入优雅关闭流程：排空正在执行的 in-flight 任务后再退出，避免提交丢失。
- 升级步骤：`devtool.sh stop judge` → 构建新版本（`cargo build --release`）或更新镜像 → `devtool.sh start judge`。
- 升级评测镜像后应先在 noj-core 白名单登记，再启动 Worker。

## 常见排查方向

- Redis 连接失败：检查 Redis 地址和服务状态。
- Docker 连接失败：确认 Docker daemon 可用，当前用户有权限访问。
- 镜像不存在：先执行 `noj-judge/scripts/build-sdk-images.sh` 构建 `noj-evaluator-python` 与 `noj-solution-python`。
- 白名单为空：确认 noj-core 已启动、`deno task dev-setup`（或 `init:system`）已执行；白名单校验在 noj-core 侧完成，judge 侧使用镜像前缀白名单复验。
- `SystemError`：通常是纯净评测包、运行时配置、镜像、协议或 evaluator 本身异常，需要查看 Judge Worker 日志。
- 提交长时间 `Pending`：见上文「队列监控」。
