# Agent Note: LMCC 工作空间真实 Extension Host 验收

Status: implemented

## Problem

Node 下的 API 和轮询测试不能证明扩展可以在编辑器宿主激活、注册命令、写入
SecretStorage 和 Memento，或通过真实文档事件维护跨域草稿。需要独立宿主运行
证据，同时区分编辑器交互与真实后端、Judge 全链路验收。

## Decision

新增 npm run test:host，使用本机安装的 Code 和已有 tsc 编译，不引入编辑器
下载框架或新依赖。启动器为每轮建立独立临时 user-data、extensions、workspace，
通过 extensionDevelopmentPath 和 extensionTestsPath 启动真实 Extension Host，
使用 --wait 等待宿主退出，保存报告及日志。无报告、失败或超时返回非零状态。 本机
Code 为 1.138.0，没有 Xvfb，实际使用现有 DISPLAY=:0 的独立窗口。

测试通过真实 vscode.extensions.activate 与已注册 vscode.commands 执行登录、
域选择、题目选择、模板、版本沿革、提交和退出。真实编辑器、文档变化事件、
进度、Memento、SecretStorage 和输出通道保持宿主实现。只替代弹窗回答，以 本地隔离
HTTP 服务提供测试响应；没有在产品中加入测试开关或暴露会话写接口。

八项场景包括双域同源题草稿隔离、不同版本草稿隔离、使用域和版本提交、隐藏
反馈不显示分数及原始输出、409 保留代码、共享撤销拒绝及退出后提交要求重新
登录。输出 spy 同时转发真实通道，报告只记录场景及请求路径，不记录令牌。

宿主验收发现共享 404 被题目选择误报为“尚未发布版本”。最小修正为读取失败
立即显示实际错误并返回，不改变权限或文件；真正缺版本的成功响应仍走原提示。
宿主断言验证资源拒绝消息与文件保留。

宿主测试与启动器加入开发入口，测试目录和 scripts 不进入 VSIX 产品包。 Prettier
检查覆盖新增启动器，普通 npm test 仍独立运行 Node/API 测试。

## Alternatives considered

- 将 Node HTTP mock 测试称为宿主验收：没有实际编辑器 API 和命令生命周期证据。
- 默认下载 Code 与新测试框架：本机已有宿主，增加依赖及下载不能改善当前验收。
- 在产品加入全局测试模式或直接写会话接口：测试会绕过真实命令交互路径。
- 复用用户日常 profile：可能影响现有窗口、账号或编辑状态。

## Consequences

开发者可以重复运行真实宿主验收，独立临时目录保存 report.json、host.log 和
profile/logs 的宿主及实际输出日志。此次八项宿主交互通过，普通 npm test 的 14
项测试通过，compile 和 check 通过。

证据边界为“真实 Extension Host + 自动交互回答 + 模拟 HTTP”。这不证明真实
core、Gateway、Judge 的授权和评测，也不代替 Public/Private/Mixed 浏览器旅程、
最低 VS Code 版本兼容或 CI。测试采用临时模拟账号，不接触真实账号或注册政策。
