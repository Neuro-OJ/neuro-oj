# Neuro OJ VS Code 扩展（`noj-vscode`）

Neuro OJ 提供独立的 Visual Studio Code 扩展（仓库：[`Neuro-OJ/noj-vscode`](https://github.com/Neuro-OJ/noj-vscode)），兼容 VS Code 与 LMCC IDE。插件用于连接你指定的 Neuro OJ 实例，不代表 CCF 或 LMCC 官方服务。

> 本页讲什么：安装扩展 → 配置服务器 → 登录 → 选题 → 提交与本地调试。

## 安装

从独立仓库 [Neuro-OJ/noj-vscode Releases](https://github.com/Neuro-OJ/noj-vscode/releases) 下载对应版本的 VSIX 资产与校验文件：

- 插件包：`neuro-oj-vscode-<version>.vsix`（例如 `neuro-oj-vscode-0.11.0.vsix`，文件名不含 tag 前缀 `v`）
- 校验文件：`neuro-oj-vscode-<version>.vsix.sha256`

下载后建议先校验 SHA-256：

```bash
sha256sum -c neuro-oj-vscode-<version>.vsix.sha256
```

然后在 Visual Studio Code 或 LMCC IDE 中打开命令面板，执行「扩展：从 VSIX 安装」，选择下载的 `.vsix` 文件并按提示重新加载窗口。

开发者也可以从独立仓库源码构建：

```bash
git clone https://github.com/Neuro-OJ/noj-vscode.git
cd noj-vscode
npm ci
npm run package
```

## 配置与登录

1. 点击 Neuro OJ 侧边栏的服务器按钮，或执行「Neuro OJ: 配置服务器地址」，填写网站地址并完成连通性验证。也可以直接修改设置项 `Neuro OJ: Server Url`。公开服务应使用 HTTPS。
2. 点击活动栏中的 Neuro OJ 图标，再点击登录按钮。
3. 输入用户名（或邮箱）与密码；账号启用两步验证时，再输入验证码或恢复码。

也可以从命令面板执行「Neuro OJ: 使用访问令牌」。

::: tip 令牌如何保存
- 密码**不会保存**；登录得到的令牌使用编辑器提供的系统加密凭据存储（`SecretStorage`）保存，不写入项目文件和日志。
- 每个服务器地址使用**独立的令牌存储槽位**，切换地址时不会把原服务器的令牌发送给新服务器。
- 账号要求首次改密时，插件会提示先到 Neuro OJ 网站完成改密，再回来登录。
:::

## 选择题目并提交

题目侧边栏只展示可接受**代码提交的公开题**，不展示客观题和产物提交题。单击一道题将其设为
当前题目，然后打开需要提交的 Python 文件并点击编辑器右上角、侧边栏标题或状态栏中的
上传按钮。

如果没有活动的 Python 编辑器，插件会在工作区查找 `submission.py`；存在多个同名文件时
会让你选择。提交前会再次显示文件与题目供确认，未保存的编辑器内容也会按当前内容提交。

提交后通知会显示排队和评测状态。完成后，得分、耗时、内存和服务端允许查看的错误输出
会写入「Neuro OJ」输出面板。

::: info 可调整的等待参数
默认等待单次评测结果 **180 秒**；可在设置中调整请求超时、轮询间隔和最长等待时间
（`neuroOj.requestTimeoutSeconds` / `neuroOj.pollIntervalSeconds` / `neuroOj.pollTimeoutSeconds`）。
:::

## 常见问题

| 现象 | 原因与处理 |
|------|-----------|
| 401 或登录失效 | 插件会清除失效令牌，请重新登录。 |
| 需要修改初始密码 | 先登录 Neuro OJ 网站完成改密，再回到插件登录。 |
| 找不到题目 | 当前版本只支持公开 Python 代码题，不支持客观题、产物题或竞赛专属提交。 |
| 题目能搜到但提交报错 | 该题已被加入一场**公开赛**：赛前与赛中该题对外一律不可访问（仅题目所有者与管理员可见，竞赛结束后自动恢复）。请到竞赛页面进入题目作答，插件只走题库入口、不携带竞赛上下文。 |
| 连接失败 | 确认网站地址包含 `http://` 或 `https://`，并检查 Neuro OJ 服务是否可访问。 |
