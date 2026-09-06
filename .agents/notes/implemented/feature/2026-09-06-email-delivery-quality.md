# Agent Note: 邮件退信与送达质量监控

Status: implemented

## Problem

现有邮件模块只负责调用阿里云 DirectMail、腾讯云 SES 或 mock 发信，没有统一的送达事件、坏地址抑制、事件幂等和脱敏告警。两家 Provider 的回调协议尚未在仓库或生产配置中确定，直接猜测 webhook 会造成伪造回调或误封地址风险。

## Decision

- 建立内部 `delivery`、`temporary_failure`、`permanent_bounce`、`complaint` 事件模型。
- 持久化事件和抑制清单；收件邮箱只保存哈希与脱敏值，事件按 `(provider, provider_event_id)` 幂等。
- 永久退信/投诉抑制验证和密码重置邮件，临时失败只记录并告警。
- 提供 `EmailDeliveryAdapter` 接口和 fixture-only HMAC 适配器，包含签名、时间戳和事件 ID 校验；阿里云/腾讯云未确认协议时不假装已实现生产 webhook。
- 通过低基数 Prometheus 指标和现有告警规则接入退信、投诉、临时失败监控；不在指标/日志暴露邮箱。

## Alternatives considered

- 直接套用通用 webhook：字段和签名并不代表阿里云/腾讯云协议，可能接受伪造或错误封禁，因此拒绝。
- 仅在 Redis 保存坏地址：重启丢失且管理端无法审计，改用 PostgreSQL 持久化。
- 立即永久封禁临时失败：会误伤短时 Provider 故障，临时失败仅告警。

## Consequences

本变更完成内部事件处理与 fixture 验证，但真实阿里云/腾讯云 webhook 仍需按官方协议另行实现并完成 sandbox/生产验收。抑制解除是显式管理员操作，解除前需确认地址已修正。
