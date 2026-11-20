# Agent Note: OI Native 比赛 CI 与本地启动门禁

Status: implemented

## Problem

比赛 HTTP 回归新增真实 C++ 评测后，默认 AI 专用 Worker 无法处理 Native 任务。
本地 SDK 构建器已经包含 `noj-oi-cpp`，但 API E2E 的 CI composite 只构建 Python
镜像； 独立 Judge job 的镜像属于另一台 runner，不能供比赛 job 使用。

## Decision

`e2e-contest` job 统一导出 `E2E_JUDGE_RESOURCE_POOLS=ai,oi-native`，
同一个配置由 Compose 注入 Worker，并由 Deno 用例决定实际运行 Native 比赛测试。
该 job 在启动评测栈之前构建固定 `noj-oi-cpp:latest`，不等待其他 job 的镜像。
比赛 CI 路径过滤同时包含 catalog、objective 与
submission，使版本、判卷和结果裁剪变更触发赛制回归。

本地 setup 保留默认 AI 专用栈，明确导出资源池并保存给后续脚本。 启用 Native
时，SDK 构建完成后确认 C++ 镜像存在；缺失时停止启动，不让测试等待无可执行任务。
SDK 刷新顺序、构建失败传播与 Compose 项目隔离三个既有门禁保持有效。 指南提供同一
shell 导出配置、启动栈、标准 contest 全量与过滤执行方式。

## Alternatives considered

- 仅设置测试进程的 Native 开关：Worker 仍为 AI
  专用，无法执行新任务，改为同一环境变量绑定双方。
- 依赖 Judge sandbox job 的 C++ 镜像：不同 runner 不共享 Docker 镜像，比赛 job
  独立构建。
- 所有 E2E job 启用 Native：无关目录不需要额外运行时，正式比赛 job 显式开启。
- 不构建镜像而将用例跳过：无法验证五赛制，正式比赛 CI 必须实际执行。

## Consequences

本地 shell 语法、启动脚本三个门禁、固定版本 actionlint、Domain CI
覆盖与测试发现检查通过。 Compose 配置验证默认池为 `ai`，显式配置为
`ai,oi-native`。 这份记录只表示验收入口已经实现，Native 比赛 HTTP
的完整通过结果仍由重建后的实际栈验收记录。 没有引入 WASI SDK
或改变默认开发评测池，也没有新增独立测试启动体系。
