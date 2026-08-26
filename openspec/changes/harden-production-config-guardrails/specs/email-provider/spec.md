## MODIFIED Requirements

### Requirement: 邮件令牌脱敏
邮件 Provider 的日志 SHALL 不输出密码重置令牌明文；当 `NOJ_ENV=production` 时，系统 MUST 在启动期拒绝 `mock`、缺失或不受支持的邮件 Provider，并 MUST 在启动期拒绝所选真实 Provider 的缺失配置。运行期发送失败仍 MUST 保持令牌脱敏。

#### Scenario: mock 生产环境发送

- **WHEN** `NOJ_ENV=production` 且 `EMAIL_PROVIDER=mock`
- **THEN** noj-core 在开始监听 HTTP 前以非零状态退出，且日志无密码重置令牌明文

#### Scenario: 真实 Provider 配置缺失

- **WHEN** `NOJ_ENV=production` 且 `EMAIL_PROVIDER=aliyun` 或 `tencent` 缺少任一必填凭据
- **THEN** noj-core 在开始监听 HTTP 前以非零状态退出，并只报告缺失的配置键名

#### Scenario: 运行期邮件错误

- **WHEN** 生产邮件 Provider 发送失败
- **THEN** 错误日志不包含密码重置 token 明文
