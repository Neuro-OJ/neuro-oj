# 容器沙箱、zip 防护与镜像

> 流程中的落点见 [flow.md](flow.md)；HostConfig 构造在
> `src/sandbox/host_config.rs`。以下限额与开关都是硬约束，不得放宽。

## 1. 容器安全项

| 项           | 值                                                                                                                          |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| capabilities | `cap_drop ALL`                                                                                                              |
| 提权         | `no-new-privileges`                                                                                                         |
| 网络         | `network_mode none`（默认）；LLM 题需联网时按 `JUDGE_ALLOW_EVALUATOR_NETWORK` 放行                                          |
| IPC          | `ipc_mode none`                                                                                                             |
| 进程数       | `pids_limit 256`                                                                                                            |
| CPU          | 每个评测容器 `JUDGE_CPU_LIMIT_MILLICORES`（默认 1000m = 1 核）                                                              |
| 根文件系统   | readonly rootfs                                                                                                             |
| `/tmp`       | tmpfs `size=256M,mode=1777,noexec,nosuid,nodev`                                                                             |
| `/workspace` | tmpfs `size=512M,mode=1777,noexec,nosuid,nodev`；prediction 题按 `workspace_size_mb` / `JUDGE_PREDICTION_WORKSPACE_MB` 覆盖 |

Evaluator 联网时加入 `JUDGE_EVALUATOR_NETWORK`（默认 `noj-eval-net`）；生产校验
**禁止** `bridge` / `host`。

## 2. zip 与文件名防护

- **路径穿越防护**：拒绝含 `..` 或 `/` 开头的 zip 条目
- **zip 炸弹防护**：最大条目数 1000、单文件 64MB、总解压 512MB（硬编码；按实际
  解压字节实时限额，不信任条目声明大小）
- **文件名安全**：拒绝含 `/`、`\`、`..` 的文件名

## 3. 镜像与命令白名单复验

镜像前缀（`JUDGE_IMAGE_PREFIX`）、命令可执行文件白名单与网络开关在任务执行前
复验；容器创建直接调 `docker.create_container`，不存在启动期的镜像拉取/探测
辅助函数。获取支持包或校验失败时**直接终止任务**，不静默放行空环境。

## 4. 重试与孤儿容器清理

- **平台错误自动重试**：`platform_error` 首次执行外最多重试 3 次；Redis 原子重投
  原消息，按 run 共享计数并保留七天。成功/正式判定/取消不重试，中间失败不写回
  core。
- **结果重试**：推送结果最多重试 3 次（指数退避），全部失败则序列化到本地文件
  系统。
- **孤儿容器清理**：启动时按**确定性实例标签**
  `com.noj.judge.instance=noj-{hash12}` 精准清理本实例残留容器（实例 ID 重启后
  不变）；同时打平台级归属标签 `com.noj.managed-by=noj-judge` 供运维兜底筛查
  （不进入启动清扫路径，避免误杀业务容器）。退出阶段（drain 超时 abort 后）在
  运行时尚存活时按同一标签做一次有界兜底清扫。
- **错误信息隐藏**：`JudgeResult::error()` 有意隐藏错误详情（不暴露内部路径/配置
  给用户）；启动前的平台侧失败（白名单复验、支持包/artifact 获取或校验）以
  `PublicJudgeError(&'static str)` 为根错误，`JudgeResult::from_error()`
  只回传其 固定公开文案，详细原因仍只写日志。

## 5. 支持包获取与缓存

| 变量                               | 默认值                         | 说明                                                        |
| ---------------------------------- | ------------------------------ | ----------------------------------------------------------- |
| `JUDGE_ALLOW_HTTP_S3`              | `false`                        | 是否允许经 HTTP 下载支持包（自建 MinIO 内网常需开启）       |
| `SUPPORT_PACKAGE_DOWNLOAD_TIMEOUT` | `60`                           | 支持包下载超时（**秒**；实现按 `Duration::from_secs` 使用） |
| `SUPPORT_CACHE_DIR`                | `/tmp/noj-judge/support-cache` | 支持包内容寻址缓存目录                                      |
| `SUPPORT_CACHE_MAX_ITEMS`          | `500`                          | 缓存最大条目数                                              |
| `SUPPORT_CACHE_MAX_MB`             | `2048`                         | 缓存最大容量（MB）                                          |

下载路径：缓存优先 → 按 host 分派（base64 / s3 / local，仅 HTTPS、禁重定向）→
SHA-256 校验 → 写缓存。实现在 `src/sandbox/download.rs` 与
`src/sandbox/cache.rs`。

## 6. 评测镜像

| 镜像                    | Dockerfile                           | 内容                                                                           | 用途                            |
| ----------------------- | ------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------- |
| `noj-evaluator-python`  | `docker/evaluator-python/Dockerfile` | `python:3.12-slim`，无额外包，依赖由 evaluate.py 自管                          | Evaluator                       |
| `noj-solution-python`   | `docker/solution-python/Dockerfile`  | `python:3.12-slim`                                                             | Solution（代码题）              |
| `noj-solution-ai`       | `docker/solution-ai/Dockerfile`      | `python:3.12-slim` + CPU torch/torchvision + CV/ML 常用库 + `noj_solution_sdk` | artifact 题（CV/ML 小模型）推理 |
| `noj-oi-cpp`            | `docker/oi-cpp/Dockerfile`           | 见 Dockerfile                                                                  | OI C/C++ 编译运行               |
| `noj-judge-test-runner` | `Dockerfile.e2e`（测试运行时）       | `python:3.12-alpine`，digest 固定                                              | E2E 测试                        |
| judge 二进制本体        | `Dockerfile.e2e`                     | 多阶段：BuildKit 缓存挂载编译 → `debian:bookworm-slim`                         | 在容器里跑 judge 二进制本身     |

```bash
./scripts/build-sdk-images.sh          # evaluator + solution + solution-ai
docker build -t noj-evaluator-python -f docker/evaluator-python/Dockerfile .
docker build -t noj-oi-cpp docker/oi-cpp
```

`.dockerignore` 排除 `target/`、`tests/`、`docker/`、`AGENTS.md`、`CLAUDE.md`
（构建上下文从 800MB+ 降至 ~200KB）。`docker/python/` 是遗留单容器运行时，
已不再使用，保留供参考。
