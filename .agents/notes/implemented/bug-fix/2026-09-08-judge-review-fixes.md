# Agent Note: 修复 judge 命令聚合评审问题

Status: implemented

## Problem

Phase 2 Task 6 的 judge 命令聚合存在 Critical 与若干 Important 问题：缺少交互式
`install` 初始化、`upgrade --dry-run` 仍会改写环境文件、`logs --follow --dry-run`
会真正执行 Docker stream、`install` 未按脚本先做基础环境检查，且 `stop`/`logs`
缺少已安装保护。

## Decision

- 为 `runJudgeCommand` 增加可选 `PromptIO` 参数，实现交互式 `initializeJudgeEnv`：
  NOJ_VERSION、Redis 来源菜单（已有/本机/稍后）、隐藏 REDIS_URL、队列/并发/
  socket/UID/GID 等提示，本机 Redis 走 `createLocalRedis`，落盘 `.env.judge` 0600。
- `upgrade --dry-run` 仅打印 `[dry-run]` 更新提示，不调用 `setJudgeEnv`；缺失环境文件在 dry-run 下同样失败。
- `logs` 在 `dryRun` 时禁用 `runner.stream` 分支，统一走 `runJudgeCompose` 打印命令。
- `install` 调整为 `checkBaseEnvironment` → `initializeJudgeEnv` → `writeJudgeCompose` → check。
- `stop` 增加环境文件存在检查；`logs` 增加 `checkBaseEnvironment` 与环境文件检查；`install-env` 增加 curl 检查。
- 用 `fileExists` 判断存在性，用显式 `stat` 读取权限位。

## Alternatives considered

- 保持交互安装为硬错误：否决。这不符合 shell 基线，也无法完成无预置配置的首次安装。
- 在 dry-run 时允许缺失 env 继续：否决。shell 基线对 `upgrade --dry-run` 同样要求已安装配置。
- 给 `logs --follow --dry-run` 单独打印 stream 命令：否决。统一走 compose dry-run 输出更简单且与基线一致。

## Consequences

- 交互式安装与 shell 脚本提示流程对齐，首次部署不再强制依赖 `--non-interactive` 或预置 env。
- dry-run 语义保持一致：只显示动作，不修改文件、不执行 Docker。
- `stop`/`logs` 在未安装时给出友好中文错误。
- 新增 7 个测试覆盖交互安装、非交互缺参、dry-run 不写入/不执行、缺失配置保护。
