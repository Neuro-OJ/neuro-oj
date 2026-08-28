# Agent Note: 真实入口 Smoke

Status: implemented

## Problem

发布物入口（编译后的 UI 单二进制、judge release binary）缺少自动化检查，入口缺失或构建产物损坏只能在部署后暴露。

## Decision

新增 `scripts/smoke-entrypoints.ts`：

- 检查四个模块的源码入口文件存在。
- 检查已构建产物（`noj-ui/dist/noj-ui`、`noj-judge/target/release/noj-judge`）存在。
- CI 新增 `entrypoint-smoke` job 运行该脚本。

当前版本只验证产物存在；实际执行 smoke（启动/`--help`/健康检查）需要安全参数与超时控制，留待后续里程碑补充。

## Alternatives considered

- 在 smoke 中直接执行二进制：`noj-ui --help` 会启动服务器导致挂起，需要更安全的参数/超时。
- 不检查入口：发布物损坏无法提前发现。

## Consequences

- 源码入口缺失会在 CI 立即失败。
- 已构建产物存在性被持续检查，为后续真实运行 smoke 打基础。
