## Why

本地 E2E 使用固定的 `noj-evaluator-python:latest` 与 `noj-solution-python:latest` 镜像。当前启动脚本不会重建这两个镜像，旧镜像会继续被复用，导致测试结果与当前 SDK 源码不一致；这正是本地 LLM Gateway E2E 曾出现导入失败的原因。

## What Changes

- 在本地 E2E 启动阶段自动构建当前工作树对应的两个 SDK 镜像。
- 让 `run-all.sh` 及直接执行 `setup.sh` 的路径使用同一套镜像刷新逻辑。
- 构建失败时立即终止启动，输出可定位的错误信息。
- 增加脚本级回归检查，验证 SDK 镜像构建命令和失败传播行为。

## Capabilities

### New Capabilities

- 无。

### Modified Capabilities

- `e2e-optimization`: 本地 E2E 启动必须确保评测 SDK 镜像来自当前工作树，避免旧 `:latest` 镜像污染测试结果。

## Impact

- 受影响文件：`scripts/e2e/setup.sh`、相关 E2E 脚本测试/文档。
- 本地 E2E 首次启动或 SDK 源码变化后会增加镜像构建时间；CI 已有独立的镜像构建步骤，不改变其编排。
- 不改变生产镜像、API、数据库或运行时协议。
