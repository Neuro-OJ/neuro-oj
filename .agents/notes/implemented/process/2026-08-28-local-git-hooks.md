# Agent Note: 本地 Git hooks 快检

Status: implemented

## Problem

本地提交前缺少快速检查，开发者往往等到 CI 才发现 `deno fmt` / whitespace 问题。

## Decision

新增 `lefthook.yml` 作为本地快检配置，并提供 `scripts/install-git-hooks.mjs` 轻量安装脚本，不依赖 npm/lefthook 二进制：

- `pre-commit`：对 staged 的 `.ts/.tsx/.vue/.rs` 文件运行 `deno fmt --check`，并运行 `git diff --cached --check`。
- `pre-push`：只输出提示，不跑全量（CI 负责完整检查）。
- 安装命令：`node scripts/install-git-hooks.mjs`。

## Alternatives considered

- 引入 npm `lefthook` 依赖：仓库无根 package.json，增加安装负担。
- 依赖 CI 全量检查：反馈太慢，浪费 CI 时间。

## Consequences

- 本地提交前能拦截格式与空白错误。
- 全量测试/类型检查仍由 CI 负责，避免本地重复跑完整套件。
