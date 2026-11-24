# Agent Note: 将 LMCC 插件升级并更名为通用 VS Code 插件（noj-vscode-extension）

Status: implemented

## Problem

原 `noj-lmcc-extension` 在命名、文案与功能上均偏向 LMCC 单文件 Python 提交，缺少题面阅读、本地工作区工程绑定、多文件 ZIP 提交、本地 Mock Evaluator 调试、云端自测与可视化 Trace 报告，难以满足 AI 工程类题目的日常刷题与开发体验。

## Decision

1. **全面去 LMCC 化与更名**：
   - 将目录从 `noj-lmcc-extension/` 更名为 `noj-vscode-extension/`，扩展包名改为 `neuro-oj-vscode`、`displayName` 改为 `Neuro OJ`，保留 `neuroOj.*` 命令与配置键前缀以兼容既有设置。
   - 同步更新 `.github/workflows/ci.yml`、`.github/workflows/release.yml`（VSIX 资产名 `neuro-oj-vscode-${VERSION#v}.vsix`）、`.github/workflows/security.yml`、`scripts/` 门禁脚本与仓库文档。
2. **工作区与拉题体验**：
   - 新增 `neuroOj.initWorkspace`（落盘 `.noj/problem.json`、`.nojignore` 与代码模板）与 `neuroOj.previewStatement`（安全转义的 Markdown 题面 Webview）。
3. **双轨本地 Mock Evaluator 与多文件/自测工作流**：
   - 新增 `neuroOj.runLocalMock`（内置 `node:http` OpenAI-compatible Mock Server，支持 `.noj/mock-llm.json` 与 Trace 采集，兼容 `noj-judge run-local` 与零 Docker Python 本地验证）。
   - 使用纯 `node:zlib` 实现无新增 npm 依赖的标准 ZIP 打包器（`zipBuilder.ts`），升级 `neuroOj.submit` 支持多文件 `multipart/form-data` 提交，并新增 `neuroOj.selfTest` 对接域内自测。
4. **IDE 内可视化反馈 Webview**：
   - 新增 `reportWebview.ts` 与 `feedbackAdapter.ts`，兼容对接 `/domains/:slug/submissions/:id/feedback` 与 `/self-tests/:id/feedback`（404 时自动回退到基础结果 `details`），展示纯 SVG 雷达图、Badcase 对比与 LLM 调用瀑布流并支持点击行号跳转源码。

## Alternatives considered

- **原地保留 `noj-lmcc-extension` 目录仅修改展示名**：会持续在文档、CI 与发布资产中保留 LMCC 强绑定语义，易产生官方关联误解；更名并同步发布资产名更为清晰彻底。
- **引入第三方 zip / chart npm 依赖**：会增加 `package-lock.json` 与 `osv-scanner` 供应链面；采用 Node 内置 `node:zlib` 与纯 SVG 保持零新增依赖。

## Consequences

- `neuro-oj-lmcc-*.vsix` 发布资产名切换为 `neuro-oj-vscode-*.vsix`，后续 Release 说明需提示老用户迁移安装新 VSIX。
- 插件可独立于后端 `/feedback` 接口合入：旧版本服务端返回 404 时自动回退解析基础 `result.details`。
