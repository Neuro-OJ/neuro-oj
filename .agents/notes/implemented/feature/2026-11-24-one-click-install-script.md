# Agent Note: 一键部署脚本 deploy/install.sh

Status: implemented

## Problem

首次安装需要手工执行五步：查版本号、下载二进制、下载校验文件、`sha256sum -c`、
再以同一标签运行 `noj-cli install`。版本号要在多处保持一致，漏掉校验或标签写错
都会导致安装失败或混用版本。此前的 `setup.sh` 与 `scripts/deploy/install.sh`
因为和 CLI 重复实现安装逻辑，已在 #402 / #540 删除。

## Decision

- 新增 `deploy/install.sh`，作为 Release 资产 `install.sh`（附 `.sha256`）发布，
  入口为 `curl -fsSL .../releases/latest/download/install.sh | bash`。
- 脚本只做“下载与转交”：检查平台（Linux amd64、glibc、Docker、Compose v2）
  → 通过 `/releases/latest` 重定向解析最新正式版标签（或用 `--version` 指定）
  → 下载二进制并校验 SHA-256 → 执行 `noj-cli install --dir <dir> --ref <tag>`，
  `--` 之后的参数原样透传。安装逻辑仍然只在 noj-cli 中实现。
- `curl | bash` 时，若 `/dev/tty` 可用，就把它接回 stdin，配置向导照常交互。
- 版本标签只接受 `vX.Y.Z[-suffix]` 形式，拒绝 `main` / `latest` 等可变引用。
- 回归测试 `scripts/deploy/install-sh_test.ts` 用 `file://` 伪造 Release，覆盖
  正常转交、校验失败中止、非法标签三条路径，已登记到 `GATE_SELF_TESTS`。

## Alternatives considered

- **恢复旧版自举脚本**：旧脚本自己写 `.env.prod`、拉镜像，和 CLI 双轨维护，
  正是当初删除它的原因。
- **只在文档里给命令清单**：步骤多、容易出错，正是这次要解决的问题。
- **用 GitHub API 解析最新版**：会受匿名访问的速率限制；走重定向不受影响。

## Consequences

- 每次 Release 多发布 `install.sh` 与 `install.sh.sha256` 两个资产。
- `releases/latest/download/install.sh` 始终指向最新正式版附带的脚本。旧版本的
  Release 里没有这个资产，需要旧版本时可以下载新脚本再传 `--version`。
- 脚本不处理 Docker 的安装和 rootless 配置，缺少时给出提示后退出。
