# Agent Note: Release CI 自动发布 noj-server / noj-cli 二进制

Status: implemented

## Problem

`setup.sh` 与 `noj-cli` 的按需下载依赖 GitHub Release 附带
`noj-cli-linux-amd64` / `noj-server-linux-amd64` 资产，但 Release CI 只构建
Docker 镜像，从未上传二进制资产，导致下载功能实际不可用。

## Decision

- 在 `.github/workflows/release.yml` 新增 `build-binaries` job：
  - 使用 `deno compile` 编译 `noj-cli-linux-amd64`（新增 `noj-cli deno task build:cli`）。
  - 复用 `noj-core/scripts/build-server.sh` 编译 `noj-server`，并重命名为
    `noj-server-linux-amd64`。
  - 生成 `.sha256` 与 `SHA256SUMS.txt`。
  - 在 `release` 事件触发时通过 `gh release upload --clobber` 上传到对应 Release。
- 该 job 仅在 `release` 事件上传资产；`workflow_dispatch` 仍可手动触发构建验证。
- 将 `noj-cli/bin/` 加入 `.gitignore`，避免编译产物误提交。

## Alternatives considered

- 在 `setup.sh` 中同时下载 noj-server：会让薄引导重新变厚，且无法覆盖
  `deploy up` 时版本升级/缺失的场景。
- 手动上传资产：容易遗漏，且无法与镜像发布保持同一版本节奏。

## Consequences

- Release 发布后会自动附带 noj-cli / noj-server 二进制与校验文件，`setup.sh`
  和 `noj-cli download` 可正常使用。
- `build-binaries` 与镜像构建并行执行，均依赖 `supply-chain-check` 通过。
- 上传需要 `contents: write` 权限，仅在该 job 内授予，不影响其他 job 的最小权限。
