# Changelog

## 0.11.0

- 更名为通用 VS Code 扩展 `neuro-oj-vscode`（仓库目录 `noj-vscode-extension`），全面去除 LMCC 专属命名耦合。
- 新增 `neuroOj.initWorkspace` 与 `neuroOj.previewStatement`：支持 `.noj/problem.json` / `.nojignore` 工作区初始化、模板落盘与安全 Markdown 题面预览。
- 新增 `neuroOj.runLocalMock`：内置 OpenAI-compatible Mock HTTP Server 与 Trace 采集，支持 `noj-judge run-local`（轨道 A）及零 Docker Python 调试（轨道 B）。
- 升级 `neuroOj.submit` 与新增 `neuroOj.selfTest`：零外部依赖实现标准 ZIP 打包，支持多文件 ZIP 提交与云端自测。
- 新增可视化评测报告 Webview：展示得分、Token/成本/延迟摘要、SVG 能力雷达图、Badcase 对比、LLM Trace 瀑布流及点击行号跳转源码，并兼容 `/feedback` 接口（404 优雅回退）。

## 0.9.5

- 支持账号密码、两步验证和访问令牌登录。
- 支持在侧边栏配置并验证自定义服务器地址，不同服务器隔离保存令牌。
- 支持题目浏览、当前题目选择与 Python 代码提交。
- 支持评测状态轮询、通知和输出面板结果展示。
- 扩展图标复用 Neuro OJ 网站品牌图标。
