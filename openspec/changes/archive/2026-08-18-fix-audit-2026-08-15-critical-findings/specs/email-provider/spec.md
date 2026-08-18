## ADDED Requirements

### Requirement: 邮件令牌脱敏
邮件 Provider 的日志 SHALL 不输出密码重置令牌明文；mock Provider 在 `NOJ_ENV=production` 时 MUST 拒绝发送或拒绝启动。

#### Scenario: mock 生产环境发送
- **WHEN** `NOJ_ENV=production` 且 `EMAIL_PROVIDER=mock`
- **THEN** 发送失败或进程启动失败，且日志无令牌明文
