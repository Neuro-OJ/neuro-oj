# Agent Note: LMCC IDE 插件

Status: implemented

## Problem

Neuro OJ 只能从网页完成选题、代码提交和结果查看，使用 LMCC IDE 或 Visual Studio Code
练习的用户需要在编辑器和浏览器之间反复切换。Issue #477 要求提供账号登录、题目选择、
一键提交 `submission.py` 和评测结果反馈能力。

## Decision

新增独立的 `noj-lmcc-extension` TypeScript 模块，最低兼容 VS Code 1.74。扩展只调用现有
`/api/v1` 公开 REST API，不组装或接触内部 `JudgeTask` 与 Redis 队列。账号密码仅用于登录
请求，JWT 使用 VS Code `SecretStorage` 保存；同时允许用户粘贴已有 JWT 并通过 `/auth/me`
验证。题目侧边栏仅展示公开代码题，提交当前 Python 编辑器内容，缺少活动编辑器时查找
`submission.py`，提交后轮询详情并在通知与输出面板反馈结果。

服务器地址可从侧边栏或命令面板配置，并通过匿名题目请求验证连通性。JWT 按规范化后的
服务器地址分槽保存，避免切换实例时把旧站点令牌发送给新站点。扩展展示图标直接复用
`noj-ui/assets/img/logo.jpg`，与网站品牌入口保持一致。

HTTP 客户端使用 Node.js 内置 `http` / `https`，避免旧版 LMCC IDE 扩展宿主缺少全局
`fetch`，也避免为简单 JSON 请求引入运行时依赖。新增 CI 路径过滤、类型检查和纯逻辑测试，
覆盖认证请求、提交 DTO、分页过滤、错误响应和轮询状态机。

## Alternatives considered

- 在插件中直接组装 `JudgeTask` 并写 Redis：绕过后端鉴权、限流、题目配置和审计，安全性与
  兼容性都不可接受。
- 使用 WebView 构建完整登录和结果页面：视觉自由度更高，但实现和维护成本明显增加；原生
  输入框、TreeView、通知与输出面板已能覆盖首版流程并保持与 IDE 主题一致。
- 使用 Axios 或依赖全局 `fetch`：Axios 增加运行时依赖，全局 `fetch` 又会抬高兼容的 VS Code
  版本，因此采用 Node 内置 HTTP。
- 使用 SSE 接收结果：服务端已有 SSE，但轮询详情更容易兼容定制版 IDE、代理和 Token 请求头；
  首版按可配置间隔轮询，后续可在兼容性验证后切换 SSE。

## Consequences

用户可在 LMCC IDE / VS Code 内完成登录、选题、Python 代码提交和结果查看。当前版本有意不
支持客观题、产物提交题、竞赛上下文和 BYOK Provider 选择；这些流程需要额外的交互与 API
语义，不能把普通代码提交错误地复用过去。发布时需要从新模块构建并分发 VSIX 文件。
