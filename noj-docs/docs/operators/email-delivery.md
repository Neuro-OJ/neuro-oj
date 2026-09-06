# 邮件退信与送达质量

## 当前边界

Neuro OJ 当前已实现阿里云 DirectMail 和腾讯云 SES 的发信 Provider，但仓库没有预置真实生产回调地址、secret 或厂商事件协议。两家服务的 webhook 字段、签名和重放规则不能互换，因此代码不会把内部 fixture 格式冒充为厂商协议。

本次实现提供：

- 内部统一事件：`delivery`、`temporary_failure`、`permanent_bounce`、`complaint`。
- `EmailDeliveryAdapter` 接口和带 HMAC-SHA256、时间戳（5 分钟窗口）、事件 ID 的 fixture 适配器，供测试和本地演练。
- 事件 ID 幂等；数据库只保存收件地址 SHA-256 哈希和脱敏地址，不保存原始 webhook。
- 永久退信和投诉进入抑制清单；验证邮件和密码重置邮件发送前查询清单，临时失败不会永久抑制。
- 管理端查看和解除抑制：`GET /api/v1/admin/email-delivery/suppressions`、`POST /api/v1/admin/email-delivery/suppressions/:id/clear`。

fixture 回调入口为 `POST /api/v1/email-events/fixture`，签名密钥使用 `EMAIL_WEBHOOK_SECRET`。该入口只用于本地/测试，不应暴露到生产公网。

## 生产 Provider 上线清单

确定公测实际 Provider 后，必须基于该 Provider 的官方文档新增适配器，并完成以下验收：

1. 官方签名、时间戳、来源校验和重放窗口测试。
2. 官方事件 ID、收件地址、事件时间、退信分类和投诉字段 fixture 测试。
3. 伪造签名、过期事件、重复事件不会写入或重复计数。
4. 真实 sandbox/生产测试事件能在管理端看到脱敏记录，永久退信地址不会再收到验证/密码重置邮件。
5. 只把 `noj_email_*` 聚合指标交给 Prometheus；日志、指标和告警不得带完整邮箱。
6. 在外部 TLS/网关层限制回调来源和速率，回调请求体不得被普通业务日志记录。

阿里云和腾讯云的生产 webhook 适配器未在本变更中声称完成；没有真实账号、回调配置和官方协议就不能宣称“真实事件验收通过”。

## 告警处置

- `NojEmailPermanentBounce`：检查坏地址抑制增长、退信分类和域名 DNS；不要批量解除抑制。
- `NojEmailComplaint`：按投诉来源暂停相关活动或模板，确认 SPF、DKIM、DMARC 与退订策略。
- `NojEmailTemporaryFailure`：检查 Provider 限流、网络、配额和域名信誉；临时失败不会自动永久封禁地址。

告警只证明 core 已收到并归一化事件，不能证明 Provider 已发送回调或实际送达。上线前仍需执行一次真实 Provider 回调演练并记录结果。
