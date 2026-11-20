# Agent Note: 教学邮件投递的持久状态

Status: implemented

## Problem

教学通知已保存受授权的资源定位，但邮件投递仍没有持久状态。进程重启和上游发送
失败不能依靠进程内队列处理，也不能把通知已读状态当作邮件发送状态。

## Decision

新增 `education_notification_emails`，以通知 ID 为主键记录 pending / sent /
skipped、
尝试次数、下次可执行时间、数据库租约和完成依据。不保存邮箱、反馈正文或成绩。
生成追加迁移 `0133_chemical_firebrand.sql`，同步 PGlite DDL 和测试清理表列表。

本提交只交付持久数据契约，消费者、发送前授权、SSE 和邮件发送在后续提交实现；
不把新增表当作通知功能已经完成。

## Alternatives considered

- 使用进程内邮件队列：重启丢失且不能协调多副本，不采用。
- 复用通知 read_at：用户阅读和邮件投递是独立行为，不采用。
- 在投递表缓存正文和邮箱：会保留失效授权的私有数据，不采用。

## Consequences

Schema parity 通过（107 表 / 972 列），迁移安全检查通过。 独立 PostgreSQL schema
`test_root_education_delivery_0133` 的标准 education 测试 104 项通过、0 失败、1
项性能场景忽略，日志
`/tmp/noj-root-education-delivery-schema-0133.log`。测试时消费者尚未接入新表，
完整通知旅程仍需后续验证。邮件发送成功但进程未登记完成时可能重发，不能承诺
上游投递严格一次。
