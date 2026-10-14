# Agent Note: 独立套件登录与本地 A+B 公开样例

Status: implemented

## Problem

Cookie 不区分 TCP 端口，同一主机的主套件和恢复套件会覆盖登录身份。本地 A+B
虽然题面写有示例，结构化 samples 为空，题目页和公开样例自测不能使用。

## Decision

- 新增 `NUXT_PUBLIC_AUTH_COOKIE_PREFIX`，默认 `noj`，独立套件各自配置。
  服务端设置与读取、改密替换、客户端会话及 401 清理、注销统一使用该前缀。
  不改变 HTTP-only、SameSite、Secure 和域授权规则。
- 入域中间件和邀请接受页也读取同一前缀，不再残留写死的 Session Cookie。
- 源码与生产环境示例、Compose 和模块文档同步记录配置。修改前缀后重新登录，
  不迁移旧令牌，也不以 Cookie 选择当前 Domain。
- 本地 A+B 经正常草稿接口增加 `sample_1`，预检通过后发布不可变 V2，
  输入 `1 2`、输出 `3`，保留题目与 V1 的稳定身份和既有提交。

## Alternatives considered

- 用端口拼 Cookie 名但只修改登录端点：其余读取和清理仍会串号，采用统一配置。
- 直接修改数据库中的已发布题目版本：违反不可变版本契约，使用正式发布流程。

## Consequences

真实同一浏览器上下文先后登录主套件管理员和恢复套件学生，刷新主套件仍为
`e2e_admin@main`；退出恢复套件后主套件身份仍保留，无页面脚本错误。
本地 A+B V2 为 `b60c0684-b61c-4c43-8f3c-9de4f6af9b89`，真实页面显示样例说明。
注销测试验证只撤销本套件 token、只删除本套件 Cookie；没有本套件 token 时不
撤销其他套件。前端 281 项组件、281 项单元及完整类型检查通过。

真实 HTTP 预览的 Playwright API 验收发现：生产 UI 镜像默认使用 Secure Cookie，
Chrome 对回环地址有特殊处理，但 API 请求不会携带该 Cookie。预览套件显式配置
`NUXT_NOJ_ENV=development` 与 `NUXT_ALLOW_INSECURE_HTTP=true` 后，同一 API 返回
200。生产 Secure 规则不修改，Cookie 名继续使用原契约；不为此引入另一套命名迁移。
