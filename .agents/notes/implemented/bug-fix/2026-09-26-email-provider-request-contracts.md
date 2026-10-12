# Agent Note: 邮件 Provider 请求契约缺陷（阿里云字段大小写 / 腾讯云正文编码）

Status: implemented

## Problem

修复「Provider 模块未被 `deno compile`
内联」后，阿里云邮件链路第一次真正发出请求， 立刻暴露出第二层缺陷：

```text
ClientError: MissingAccountName: code: 400,
AccountName is mandatory for this action. request id: 01A0DC95-...
```

`email-providers/aliyun.ts` 用 **PascalCase** 构造 SDK 请求：

```ts
const req = new SendMailRequest({
  AccountName: fromEmail,
  ToAddress: email,
  Subject: subject,
  HtmlBody: html,
  AddressType: 1,
});
```

而 `@alicloud/dm20151123` 的请求模型继承自 `$dara.Model`，**只识别 camelCase
属性**， 再由模型自带的 `names()`（`accountName → AccountName`）映射为 wire
参数。实测：

```text
PascalCase kept fields: 0 → wire: {}
camelCase  kept fields: 6
```

构造器静默丢弃全部字段（不抛错、不告警），服务端因此只报第一个必填参数缺失。
错误信息具有误导性——`MissingAccountName` 看起来像 `ALIBABA_FROM_EMAIL` 没配置，
实际该值早已正确注入容器（`.env.prod` / 设置注册表均正常）。

同一轮排查还发现腾讯云通道的同类"从未被执行过"缺陷：`tencent.ts` 用 `btoa(html)`
编码正文，而本站邮件模板正文含中文，`btoa` 只接受 Latin-1 字符，会在 **本地**抛
`InvalidCharacterError: The string to be encoded contains characters outside
of the Latin1 range`——腾讯云通道从未成功发过一封信。

三者共同的成因是同一个：邮件 Provider 模块在编译产物中被排除，这段代码在生产
**从未运行过**，因此所有只在运行时才成立的契约（模块可加载、字段名被识别、编码可用）
都没有被任何测试或环境覆盖到。

## Decision

1. **阿里云：抽出 `buildSendMailParams()` 并改用 camelCase 字段**
   （`accountName` / `replyToAddress` / `addressType` / `toAddress` / `subject`
   / `htmlBody`）， 函数导出以便测试；注释写明 PascalCase 会被静默丢弃、以及
   `replyToAddress: false` 的取值理由（置 `true` 会被要求同时提供
   `ReplyAddress`）。
2. **腾讯云：`btoa(html)` 改为 `encodeHtmlBase64(html)`**
   （`@std/encoding/base64` 对 `TextEncoder` 的 UTF-8
   字节编码），函数导出以便测试。
3. **把契约写进测试（离线、不联网）**：
   - `aliyun 请求字段必须能被 SDK 模型映射为 wire 参数`：直接取
     `SingleSendMailRequest.names()`，断言传入的每个字段都被模型识别，并按
     `names()` 映射后校验
     `AccountName`/`ToAddress`/`Subject`/`HtmlBody`/`AddressType`/`ReplyToAddress`
     的取值。PascalCase 写法会在此处立刻失败（映射后 wire 为空）。
   - `tencent 中文 HTML 的 base64 编码按 UTF-8 字节`：断言 base64 可还原为原始
     UTF-8 字节。 两条都在 `tests/shared/email-providers.test.ts`，随
     `bash scripts/test-shared.sh` 执行。
4. **真实验收仍在产物上**：把重建镜像装入部署实例，用管理后台
   `POST /api/v1/admin/system/settings/email/test-send` 与
   `POST /api/v1/auth/forgot-password`（覆盖 `sendEmail` 与
   `sendPasswordResetEmail` 两条路径）实际发出邮件，日志确认阿里云返回
   `envId`/`requestId`。

## Alternatives considered

- **阿里云改用 `@alicloud/dm20151123` 之外的手写 HTTP 调用**：绕开 SDK
  的模型映射，
  但需要自行处理签名（ACS3/HMAC）、重试与错误码，收益只是省掉一次字段名大小写约定，
  不采用。
- **只改阿里云，腾讯云留给后续版本**：腾讯云通道当前没有可用凭据、无法端到端验证，
  但它与阿里云是同一类缺陷（本地编码阶段必抛），且修复可静态证明（base64
  往返断言）； 留着等于明知有缺陷还发布，故一并修，并在 Agent Note
  中标注"仅静态验证"。
- **只加"字段名必须是 camelCase"的源码字符串断言**：能拦住回归，但不知道字段是否
  真的能被 SDK 识别（SDK 升级改字段名时不会失败）；改为直接对 SDK
  模型做契约断言。
- **给阿里云请求模型做一层类型包装（`as SendMailRequest` 强类型）**：`@alicloud`
  的 `SingleSendMailRequest`
  类型确实能给出编译期保护，但它是运行时动态导入（CJS/ESM 互操作），`deno check`
  无法对其做类型约束；故用运行时契约测试替代。

## Consequences

- 阿里云邮件链路端到端可用：管理后台测试邮件、注册邮箱验证、找回密码三条路径共用
  `sendEmail`/`sendPasswordResetEmail`，均已在部署实例上验通。
- 字段名/编码这两类"只在运行时成立"的契约现在有离线测试守护；SDK
  若调整模型字段名， `names()` 契约测试会失败而不是静默丢字段。
- 腾讯云通道的修复目前**只有静态测试覆盖**（无凭据，未做真机发送），首次启用该通道时
  应补一次真实发送验证。
- 这类"从未被执行过"的代码仍可能有其他未覆盖路径（例如腾讯云的区域/端点配置、
  SDK 返回结构解析）；本次只覆盖了已暴露的三处。
