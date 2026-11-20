# Agent Note: LLM 运营文档按使用域配置对齐

Status: implemented

## Problem

旧运营页面仍要求全平台统一选择 Provider／模型、创建 P 型题，且说停用后的 token
可以继续调用。这些说明与域内配置、数字题号及 Gateway 当前启用检查相矛盾。

## Decision

更新 LLM 接入与后台管理指南：明确使用域页面、独立模型和配额、revision 更新、
尝试冻结及实时 Provider 停用规则。旧平台默认只作为 main 初始化已有配置的依据。
保留服务部署密钥、网关网络与存储安全说明，不把预估费用称为上游绝对账单封顶。

## Alternatives considered

- 只链接新工作空间说明：旧页面仍给出错误的具体操作。
- 删除部署说明：网关服务与 evaluator 网络依然需要配置。

## Consequences

运营者按目标域配置，引用公共题时不会误用来源域密钥；文档字段语义与域 API
一致。此批为说明修正，未修改执行逻辑或声明新的上游调用验收。
