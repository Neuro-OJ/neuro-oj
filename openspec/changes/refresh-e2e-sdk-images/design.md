## Context

本地 `scripts/e2e/setup.sh` 调用 E2E Compose 启动完整栈，但两个 SDK 镜像由固定的 `noj-evaluator-python:latest` 和 `noj-solution-python:latest` 引用。Compose 的构建复用会让旧镜像遮蔽当前工作树的 SDK 变化；CI 已经单独构建并加载镜像，因此本变更聚焦本地路径。

## Goals / Non-Goals

**Goals:**

- 本地 E2E 启动前构建当前工作树的两个 SDK 镜像。
- 构建失败立即终止，并保留可定位的错误输出。
- 为脚本行为提供无需依赖真实镜像缓存状态的回归测试。

**Non-Goals:**

- 不修改生产 Compose、CI E2E 的镜像构建策略或镜像仓库标签。
- 不改变判题协议、容器安全配置和题目评测逻辑。

## Decisions

- 在 `setup.sh` 的本地分支中调用已有的 `noj-judge/scripts/build-sdk-images.sh`，复用项目既有的双镜像构建入口，避免在 E2E 脚本中重复 Dockerfile 和 tag 定义。
- SDK 构建放在 Compose 启动之前；这样构建失败不会留下“服务已启动但测试使用旧 SDK”的模糊状态。
- 保持 CI 分支跳过本地构建，因为 `.github/workflows/e2e.yml` 已使用 `docker/build-push-action` 构建并加载两个同名镜像。
- 为避免直接执行 `setup.sh` 与 `run-all.sh` 行为分叉，`run-all.sh` 继续委托 `setup.sh`，不新增第二个刷新入口。

## Risks / Trade-offs

- [Risk] 每次本地 E2E 启动都会检查/构建 SDK 镜像，冷缓存时耗时增加 → [Mitigation] 继续使用 Docker layer cache，并复用现有构建脚本。
- [Risk] 本机 Docker 不可用时错误信息可能混入 Compose 输出 → [Mitigation] 在前置构建步骤中保留明确的阶段提示，并依赖构建脚本的非零退出状态。
- [Risk] SDK Dockerfile 或构建脚本路径未来变化 → [Mitigation] 添加脚本静态检查，锁定入口脚本和两个目标 tag。

## Migration Plan

1. 更新本地 E2E 启动脚本和脚本回归测试。
2. 在存在旧 SDK 镜像的环境中运行 E2E，确认启动前镜像被刷新并通过 LLM Gateway 测试。
3. 如需回滚，移除本地前置构建调用即可；不会影响持久化数据或生产服务。
