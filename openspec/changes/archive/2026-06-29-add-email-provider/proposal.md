## Why

PR #72 已实现基于 `console.log` 的邮件 mock，用于支持密码重置流程。为了在生产环境真实发送邮件，需要引入可插拔的邮件发送抽象层，支持主流云厂商的邮件推送服务，并保留 mock 模式用于开发与 E2E 测试。

## What Changes

- 在 `noj-core/src/lib/email.ts` 中定义统一的邮件发送接口 `sendPasswordResetEmail(email, resetLink, expiresInMinutes)`。
- 新增策略化 Provider 选择，通过 `EMAIL_PROVIDER` 环境变量切换：
  - `mock`：控制台输出邮件内容（默认，保持当前行为不变）。
  - `aliyun`：接入阿里云 DirectMail SDK（`@alicloud/dm20151123`）。
  - `tencent`：接入腾讯云 SES SDK（`tencentcloud-sdk-nodejs-ses`）。
- 新增 Provider 实现目录 `noj-core/src/lib/email-providers/`，每个 Provider 独立封装 SDK 调用与参数转换。
- 在 `noj-core/.env.example` 增加各 Provider 所需环境变量模板。
- 保持 `passwordReset.ts` 调用方不变，仅 `await sendPasswordResetEmail(...)`。
- E2E 测试继续沿用 mock 模式，不依赖真实云账号；Provider 集成的正确性通过类型检查和单元测试覆盖。

## Capabilities

### New Capabilities

- `email-provider`：系统提供统一的邮件发送抽象，支持阿里云 DirectMail、腾讯云 SES 及 mock 三种 Provider，用于发送密码重置等事务性邮件。

### Modified Capabilities

- （无 spec 级行为变更，用户认证流程对外接口和语义保持不变）

## Impact

- **代码目录**：新增 `noj-core/src/lib/email-providers/`、`noj-core/tests/lib/email-providers/`。
- **依赖**：`deno.json` 引入 `npm:@alicloud/dm20151123` 与 `npm:tencentcloud-sdk-nodejs-ses`。
- **配置**：新增环境变量 `EMAIL_PROVIDER`、`ALIBABA_ACCESS_KEY_ID`、`ALIBABA_ACCESS_KEY_SECRET`、`TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY` 等。
- **测试**：密码重置路由/服务测试不受影响；新增 Provider 单元测试仅在 mock 数据上验证参数转换与错误处理。
- **文档**：`noj-core/.env.example` 和 `noj-core/AGENTS.md` 更新邮件配置说明。
