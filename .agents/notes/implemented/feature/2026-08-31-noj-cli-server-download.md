# Agent Note: noj-cli 按需下载 noj-server 二进制

Status: implemented

## Problem

`noj-cli` 的 `deploy up` 与 `run-server` 在 process 模式下需要本地存在
`noj-server` 二进制，但安装引导只负责下载 `noj-cli`，用户仍需手动准备
`noj-server`，导致“薄引导 + 一键部署”的体验断裂。同时 `deploy init`
生成的配置把 `noj_server` 版本写死为 `0.1.0`，无法跟随 GitHub Release
自动使用最新版本。

## Decision

- 新增 `src/runtime/download.ts`：
  - `resolveLatestVersion()` 从 GitHub API 解析最新 Release tag（去掉前导 `v`）。
  - `ensureNojServerBinary()` 确保 `<install_dir>/bin/noj-server` 存在且版本匹配；
    缺失时从 GitHub Releases 下载 `noj-server-linux-amd64` 与 `.sha256`，
    校验 SHA-256 后原子落盘并记录版本文件 `noj-server.version`。
  - 已存在同版本二进制直接复用；已存在但无版本文件的二进制视为用户自建，不覆盖。
- `deploy up` 与 `run-server` 在 process 组件未配置 `dev_command` 且
  `binary` 为 `noj-server`（或 server 组件缺省）时，先调用
  `ensureNojServerBinary` 再启动进程。
- `deploy init` 的 TUI 在未显式指定版本时尝试解析最新版本，网络失败回退到
  `DEFAULT_NOJ_SERVER_VERSION`；`devTemplate` / `prodTemplate` 支持传入版本号，
  同步写入 `version.noj_server` 与各镜像 tag。

## Alternatives considered

- 继续要求用户手动下载 `noj-server`：实现简单，但破坏一键部署体验。
- 在安装入口中同时下载 `noj-server`：会让首次安装依赖更多资产，且无法覆盖
  `deploy up` 时版本升级/缺失的场景。
- 不校验 SHA-256：下载更快，但供应链安全不可接受，与现有发布资产校验约定不一致。

## Consequences

- `deploy up` / `run-server` 首次运行可能触发网络下载，需要 GitHub Releases
  可访问；失败时进程启动失败并进入 `partial` 状态（`deploy up`）。
- 新增 `download.ts` 及其单元测试；`deploy_test` / `process_test` 通过预置
  本地二进制避免测试依赖网络。
- `deploy init` 会发起一次 GitHub API 请求；网络不可用时仅告警并回退默认版本。
- 当前发布流程要求 GitHub Release 附带 `noj-server-linux-amd64` 与
  `.sha256` 资产，命名与 `noj-cli-linux-amd64` 资产约定一致。
