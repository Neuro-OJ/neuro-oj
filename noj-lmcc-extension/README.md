# Neuro OJ for LMCC IDE

这是 Neuro OJ 的 LMCC IDE / Visual Studio Code 扩展。它调用 Neuro OJ 的公开
`/api/v1` 接口，不会直接访问数据库或内部评测队列。

## 功能

- 使用用户名（或邮箱）和密码登录，支持两步验证；也可粘贴已有 JWT 访问令牌。
- 可从侧边栏或命令面板配置并验证任意 Neuro OJ 网站地址；不同服务器的令牌相互隔离。
- 令牌保存在 VS Code `SecretStorage` 对应的系统加密凭据存储中。
- 在侧边栏浏览公开代码题并选择当前题目。
- 从编辑器标题、侧边栏或状态栏一键提交当前 Python 文件。
- 没有活动 Python 编辑器时，自动查找工作区中的 `submission.py`。
- 提交后显示排队状态，轮询完成后在通知和“Neuro OJ”输出面板展示得分、耗时、内存和错误输出。

## 本地安装

```bash
cd noj-lmcc-extension
npm ci
npm run package
```

在 LMCC IDE 或 VS Code 中执行“扩展：从 VSIX 安装”，选择生成的 `.vsix` 文件。

安装后点击侧边栏的服务器按钮，或执行“Neuro OJ: 配置服务器地址”。也可以在设置中填写
`Neuro OJ: Server Url`。默认值
`http://localhost:3000` 适合本地开发；公开服务应使用 HTTPS 网站地址。打开左侧
Neuro OJ 图标后登录、选择题目，再打开 Python 文件点击上传按钮。

## 开发检查

```bash
npm ci
npm run check
npm test
```

扩展最低兼容 VS Code 1.74，并仅使用该版本已具备的扩展 API。
