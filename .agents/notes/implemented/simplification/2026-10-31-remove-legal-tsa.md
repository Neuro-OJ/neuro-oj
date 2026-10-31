# Agent Note: 删除法律文档 TSA 功能

Status: implemented

## Problem

#698 指出的 RFC 3161
时间戳功能默认关闭，却引入了签发、验签、证书链、配置和专用密码学依赖的维护成本。用户明确要求删除
TSA。

## Decision

删除 TSA 服务、验签接口、模块导出、后台标签页、配置及环境变量、专用测试和
pkijs/asn1js 依赖。通过 Drizzle 生成迁移删除版本表中的五个 TSA
字段，并清理三项旧配置。政策版本、SHA-256
内容哈希、发布时间、审计和用户同意记录继续保留；更新现有测试验证发布与哈希绑定。

## Alternatives considered

仅关闭开关仍需维护整条链路；保留旧验签入口或新增兼容层也不符合直接删除的要求，因此均不采用。

## Consequences

升级迁移会删除旧 TSA 字段及其数据，旧验签接口不再提供，TSA
环境变量不再注册。法律文档发布不再请求外部时间戳服务。历史迁移和设计记录保留原貌。

验证：`deno task test:domain platform --filter legal` 通过 21
项测试；修改文件的格式、lint、后端类型检查及 Vue script/template
编译通过。迁移在临时表上验证旧数据升级，正文和哈希保留、三项 TSA 配置删除；Agent
Note、迁移安全和路由目录门禁通过。
