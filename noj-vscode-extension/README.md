# Neuro OJ for VS Code

这是 Neuro OJ 的通用 Visual Studio Code 扩展（`neuro-oj.neuro-oj-vscode`）。它通过
Neuro OJ 公开 `/api/v1` 接口完成认证、工作区拉题、云端自测、单文件/多文件 ZIP
提交与可视化评测反馈，并内置本地 Mock LLM Server 支持零 Docker 离线调试。

## 核心功能

- **账号与多服务器隔离**：支持用户名/邮箱 + 密码（含两步验证）与访问令牌登录，凭据按服务器地址隔离存储在系统 `SecretStorage`。
- **工作区绑定与拉题（`neuroOj.initWorkspace` / `neuroOj.previewStatement`）**：
  - 在选定目录创建 `.noj/problem.json` 与 `.nojignore`（默认忽略 `.venv`、`__pycache__`、`.git`、`node_modules`、`.noj`），自动拉取入口模板。
  - 在安全转义的 Webview 中预览 Markdown 题面、样例与版本限制。
- **双轨本地 Mock 调试（`neuroOj.runLocalMock`）**：
  - 内置轻量 OpenAI-compatible Mock HTTP Server（支持默认回显与 `.noj/mock-llm.json` 预设回复/延迟），记录请求耗时、估算 Token 与消息摘要。
  - **轨道 A**：检测到本机 `noj-judge` 时组装同构 `JudgeTask` JSON 调用 `noj-judge run-local`。
  - **轨道 B**：零 Docker 轻量调试——优先运行 `.noj/local_eval.py` 或直接运行当前 Python 脚本，注入 `OPENAI_BASE_URL` / `NOJ_LLM_GATEWAY_URL` 指向本地 Mock Server 并生成 Trace 报告。
- **单文件 & 多文件 ZIP 提交（`neuroOj.submit`）**：
  - 零外部依赖内置标准 ZIP 打包器（CRC32 + Raw DEFLATE），自动应用 `.nojignore` 过滤。
  - 支持单文件 JSON 代码提交与 `artifact` / 多文件项目 `multipart/form-data` ZIP 上传。
- **云端 Self-Test（`neuroOj.selfTest`）与可视化评测报告**：
  - 调用 `/api/v1/domains/:slug/problems/:reference/self-tests` 发起自测并轮询结果。
  - 兼容 `/feedback` 结构化反馈接口（旧后端 404 时自动回退到 `SubmissionDetail`），在 Webview 中展示得分与状态、Token/成本/延迟摘要、纯 SVG 能力雷达图、Badcase 左右对比、LLM Trace 瀑布流，以及点击文件行号跳转源码。

## 本地打包与安装

```bash
cd noj-vscode-extension
npm ci
npm run package
```

在 VS Code 中执行“扩展：从 VSIX 安装”，选择生成的 `.vsix` 文件。

## 开发与测试

```bash
cd noj-vscode-extension
npm ci
npm run check
npm test
```

若本机已安装 VS Code 二进制，可运行独立 Extension Host 验收：

```bash
npm run test:host
```

可通过 `NOJ_VSCODE_BINARY` 指定可执行文件路径。测试会自动创建独立临时 profile 与工作目录，不污染日常配置。
