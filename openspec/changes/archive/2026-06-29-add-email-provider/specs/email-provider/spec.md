## ADDED Requirements

### Requirement: 邮件发送抽象接口

系统 SHALL 提供一个统一的邮件发送接口 `sendPasswordResetEmail(email, resetLink, expiresInMinutes)`，用于发送密码重置邮件。调用方无需关心底层邮件服务商实现。

#### Scenario: 默认 mock 模式

- **WHEN** 未配置 `EMAIL_PROVIDER` 环境变量时
- **THEN** 系统使用 mock Provider，将邮件内容输出到控制台，不调用外部服务

#### Scenario: 显式选择 Provider

- **WHEN** 配置 `EMAIL_PROVIDER=aliyun` 或 `EMAIL_PROVIDER=tencent`
- **THEN** 系统 SHALL 使用对应云厂商的邮件服务发送邮件

### Requirement: 阿里云 DirectMail Provider

当 `EMAIL_PROVIDER=aliyun` 时，系统 SHALL 使用阿里云 DirectMail SDK 发送邮件。

#### Scenario: 使用阿里云发送密码重置邮件

- **WHEN** 调用 `sendPasswordResetEmail` 且已配置 `ALIBABA_ACCESS_KEY_ID`、`ALIBABA_ACCESS_KEY_SECRET`、`ALIBABA_FROM_EMAIL`
- **THEN** 系统 SHALL 调用 DirectMail 单条发信接口，收件地址为 `email`，主题为密码重置，正文包含 `resetLink`

#### Scenario: 阿里云配置缺失

- **WHEN** `EMAIL_PROVIDER=aliyun` 但缺少必要环境变量
- **THEN** 系统 SHALL 抛出配置错误，不静默失败

### Requirement: 腾讯云 SES Provider

当 `EMAIL_PROVIDER=tencent` 时，系统 SHALL 使用腾讯云 SES SDK 发送邮件。

#### Scenario: 使用腾讯云发送密码重置邮件

- **WHEN** 调用 `sendPasswordResetEmail` 且已配置 `TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`、`TENCENT_FROM_EMAIL`、`TENCENT_REGION`
- **THEN** 系统 SHALL 调用腾讯云 SES `SendEmail` 接口，收件地址为 `email`，主题为密码重置，正文包含 `resetLink`

#### Scenario: 腾讯云配置缺失

- **WHEN** `EMAIL_PROVIDER=tencent` 但缺少必要环境变量
- **THEN** 系统 SHALL 抛出配置错误，不静默失败

### Requirement: Provider 选择不可扩展时不影响现有行为

系统 SHALL 保证新增 Provider 后，密码重置服务的对外行为不变。

#### Scenario: mock 模式下密码重置流程不变

- **WHEN** 用户请求密码重置且使用 mock Provider
- **THEN** 系统仍按现有流程生成 token、写入数据库，并仅通过控制台记录邮件内容
