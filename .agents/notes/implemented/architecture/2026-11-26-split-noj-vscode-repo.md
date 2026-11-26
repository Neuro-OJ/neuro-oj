# Agent Note: 将 VS Code 扩展拆分至独立仓库 Neuro-OJ/noj-vscode

Status: implemented

## Problem

`noj-vscode-extension` 为纯 TypeScript / VS Code Extension API 项目，与主仓库其余 Deno / Rust 服务无源码级耦合，但留在主仓中会绑定统一的模块版本号校验（`check-version-consistency.ts`）与主平台 Release 流水线（`publish-ide`），不利于扩展独立高频迭代与发布 `.vsix`。

## Decision

1. 将扩展完整提交历史迁移至独立公开仓库 [`Neuro-OJ/noj-vscode`](https://github.com/Neuro-OJ/noj-vscode)，并在独立仓库配置 CI（`npm run check` / `npm test` / `vsce package`）与 tag 触发的 Release VSIX 发布流。
2. 在主仓库移除 `noj-vscode-extension/` 目录及相关门禁条目（`ci.yml` 的 `vscode-extension-check`、`security.yml` 的 `osv-scanner` 锁文件、`release.yml` 的 `publish-ide`、`scripts/check-version-consistency.ts` 等），同时将 `noj-cli` 的 `ReleaseSet.ide_version` 调整为向后兼容的可选字段；为兼容尚未升级 CLI 的存量节点，`scripts/release/generate-release-set.ts` 在过渡窗口期继续输出 `ide_version`。
3. 同步更新 `AGENTS.md`、`README.md`、`dev-docs/agents/module-map.md`、`noj-docs/` 中的独立仓库与下载链接说明。

## Alternatives considered

- **继续留在主仓库**：跨模块契约对照方便，但受限于主仓库统一版本号和完整 CI/Release 节奏；鉴于扩展零源码依赖且已升级为通用客户端，独立仓库更利于长期演进。

## Consequences

- 主仓库 `VERSION_MANIFESTS` 从 7 个模块收敛为 6 个；`check-release-version.ts` 与 `check-supply-chain.sh` 同步移除 IDE 资产耦合。
- 后续若 `noj-core` / `noj-judge` 变更评测接口或 `OiRuntimeConfig` / SDK 环境变量契约，需同步在 `Neuro-OJ/noj-vscode` 仓库跟进兼容。
