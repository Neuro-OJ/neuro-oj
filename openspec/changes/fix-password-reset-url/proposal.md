## Why

密码重置链接当前由请求头中的 `Host` 和 `X-Forwarded-Proto` 拼接，攻击者可以构造请求让重置邮件指向其控制的站点并窃取令牌。#261 需要在生产环境彻底切断请求头对重置链接来源的控制，同时保留开发环境的便捷回退。

## What Changes

- 新增 `APP_URL` 环境变量作为密码重置链接的可信应用基础 URL。
- 密码重置服务优先使用 `APP_URL`；非生产环境未配置时才回退到请求头拼接的 URL。
- 生产环境未配置 `APP_URL` 时跳过令牌和邮件发送，记录内部错误日志，并继续返回防枚举所需的统一 200 响应。
- 在开发环境和测试中补充 Host Header 注入与生产缺失配置的回归测试，并更新环境变量模板。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `user-auth`: 收紧密码重置链接的可信来源及生产环境缺失配置时的处理要求。

## Impact

- 受影响代码：`noj-core/src/routes/auth.ts`、`noj-core/src/services/passwordReset.ts`，以及环境变量快照/配置模板。
- 受影响测试：密码重置服务和认证路由测试。
- 不新增依赖，不改变密码重置 API 的公开响应格式；数据库结构不变。
