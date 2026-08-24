# Judge Worker 运维

本文覆盖 noj-judge 的职责、运行时镜像、评测流程、队列监控、水平扩展与升级。

## Worker 职责

`noj-judge` 从 Redis 队列拉取评测任务，下载纯净评测包，为每次评测即时创建
Evaluator + Solution 双容器（用后即毁），并把结果写回 Redis。

支持多个 Judge Worker 实例水平扩展：所有实例消费同一个 Redis 队列，互不冲突。

### 评测并发上限

单个 Worker 同时执行的评测任务数由 `JUDGE_MAX_CONCURRENT_JUDGES` 控制，默认值为
`2`，有效范围为 `1` 至 `1024`。未设置或超出范围时使用默认值；需要提高吞吐时，
应结合 Docker、CPU、内存和数据库连接池容量调整该值。

### 评测容器资源

每个 Worker 创建的 Evaluator 和 Solution 容器默认限制为 1 个 CPU 核。可通过
`JUDGE_CPU_LIMIT_MILLICORES` 调整该 Worker 的统一上限，单位为 millicores：
`1000m = 1 核`，有效范围为 `100m` 至 `16000m`。未设置或超出范围时回退到
`1000m`，不会因为配置为 `0` 而变成不限制 CPU。

## Docker daemon 权限边界

`noj-judge` 需要调用 Docker API 创建评测容器。生产环境不得把应用宿主机的
`/var/run/docker.sock` 直接挂载给 Worker；该 socket 等价于授予 Docker daemon
控制权限，Worker 被攻破后可能影响宿主机上的其他服务。

生产部署必须选择以下一种边界：

1. 在独立 judge 主机上运行 Docker daemon；或
2. 在应用主机上运行只服务于 judge 的 rootless Docker daemon，并使用独立 Unix
   socket。

生产 Compose 使用以下配置连接该 socket：

```bash
JUDGE_DOCKER_SOCKET=/run/noj-judge/docker.sock
JUDGE_DOCKER_SOCKET_GID=10001
JUDGE_DOCKER_HOST=unix:///run/noj-judge/docker.sock
JUDGE_REQUIRE_ISOLATED_DOCKER=true
```

`JUDGE_DOCKER_SOCKET` 是宿主机上独立 daemon 的 socket 路径，不能填写应用宿主机
的 `/var/run/docker.sock`。`JUDGE_DOCKER_SOCKET_GID` 必须匹配该 socket 的组权限，
Compose 会以非 root 用户运行 Worker，并只挂载该 socket 和评测缓存。

开启 `JUDGE_REQUIRE_ISOLATED_DOCKER=true` 后，Worker 会在启动阶段拒绝
`/var/run/docker.sock` 与 `/run/docker.sock`，也会拒绝 `tcp://`、`http://` 等
未实现安全认证的 endpoint；校验失败时不会开始消费评测队列。开发环境可以省略
这两个变量，继续使用默认本地 daemon，但不应将该配置用于生产。

部署前检查：

```bash
test "$JUDGE_DOCKER_HOST" = "unix:///run/noj-judge/docker.sock"
test "$JUDGE_REQUIRE_ISOLATED_DOCKER" = "true"

# 只应看到独立 daemon socket 和评测缓存，不得出现应用宿主机 socket、
# /var/lib/docker、/etc 或其他宿主路径。
docker compose --env-file .env.prod -f docker-compose.prod.yml config
docker inspect "$(docker compose --env-file .env.prod -f docker-compose.prod.yml ps -q judge)" \
  --format '{{json .Mounts}}'
```

首次发布时先启动一个 Worker，观察日志中的 Docker PING 成功信息，再执行一次
无害的样例评测；确认结果正常后再扩容其他 Worker。升级时先停止 Worker，替换
镜像并重复上述检查。若需回滚，恢复上一版本镜像和同一组 endpoint 配置，启动后
确认带有本实例标签的孤儿容器已被清理；不要通过回滚重新挂载应用宿主机 socket。

## 双容器运行时

默认 Python 题目使用两个镜像（生产环境从 ghcr.io 拉取）：

- `ghcr.io/neuro-oj/noj-evaluator-python`：运行出题人的 `evaluate.py`。
- `ghcr.io/neuro-oj/noj-solution-python`：运行用户提交的 `solution.py` 和 Solution Host。

Evaluator 容器可以通过 Neuro OJ Evaluator SDK 调用 Solution 容器中的用户函数。

### 构建/发布评测镜像

评测镜像由 GitHub Actions 在 Release 时自动构建并推送到 ghcr.io，无需在服务器上构建。

本地开发/调试时仍可使用 `noj-judge/scripts/build-sdk-images.sh`：

```bash
cd noj-judge
./scripts/build-sdk-images.sh               # 构建两个镜像，默认 tag :latest
./scripts/build-sdk-images.sh --tag v0.1.0  # 自定义 tag
```

生产部署时，`init system` 会根据 `JUDGE_IMAGE_BASE`（默认 `ghcr.io/neuro-oj/`）写入
ghcr 全限定镜像名；若需要手工确认，见[生产部署](production-deploy.md#评测镜像白名单)。

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

生产环境使用 Docker Compose 管理：

```bash
# 查看所有服务状态（含 judge 是否在线）
docker compose --env-file .env.prod -f docker-compose.prod.yml ps

# 查看 judge 日志
docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f --tail=200 judge
```

调高日志详细度排查问题（临时覆盖环境变量）：

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml run --rm \
  -e RUST_LOG=noj_judge=debug judge
```

## 队列监控 {#queue-monitoring}

评测任务在 Redis 队列 `noj:judge:queue` 中排队，结果写回 `noj:judge:results`：

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml exec redis \
  redis-cli -a "$REDIS_PASSWORD" LLEN noj:judge:queue
```

如果队列持续堆积：

1. 确认 Judge Worker 在线且连接了同一个 Redis（`docker compose ps`）。
2. 查看 judge 日志是否有拉取/容器错误。
3. 检查 Docker daemon 是否可用、评测镜像是否已从 ghcr.io 拉取。
4. 如负载确实超过单实例能力，按下一节水平扩展。

## 水平扩展

启动多个 noj-judge 实例即可分担负载：

- 所有实例消费同一个 `noj:judge:queue`，互不冲突。
- 新实例启动后即可消费任务，无需额外注册。

## 升级与重启

- 停止实例会进入优雅关闭流程：排空正在执行的 in-flight 任务后再退出，避免提交丢失。
- 升级步骤：修改 `.env.prod` 中的 `NOJ_VERSION` → `docker compose pull` → `docker compose up -d`。
- 升级评测镜像后应先在 noj-core 白名单登记，再启动 Worker。

## 常见排查方向

- Redis 连接失败：检查 Redis 地址和服务状态。
- Docker 连接失败：确认 Docker daemon 可用，当前用户有权限访问。
- 镜像不存在：确认 ghcr.io 镜像已发布，且 `judge_images` 白名单中的镜像名与发布的 ghcr 全限定名一致。
- 白名单为空：确认 noj-core 已启动、`init system` 已执行；白名单校验在 noj-core 侧完成，judge 侧使用镜像前缀白名单复验。
- `SystemError`：通常是纯净评测包、运行时配置、镜像、协议或 evaluator 本身异常，需要查看 Judge Worker 日志。
- 提交长时间 `Pending`：见上文「队列监控」。
