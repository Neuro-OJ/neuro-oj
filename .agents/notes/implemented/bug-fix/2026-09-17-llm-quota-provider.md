# Agent Note: 修复 LLM 配额窗口与 Provider 更新

Status: implemented

## Problem

LLM 日/月计数项重复生成，使同一次请求重复扣算且窗口上限混用（#522）。
Provider 更新将绑定参数展开给 postgres.js，导致编辑失败（#523）。

## Decision

计数器构造函数显式接收窗口，每个 key 仅生成一次，并从同一个时间快照计算
窗口日期及 TTL。预扣与结算均使用这一约定。Provider 更新传入有类型的参数数组。
回归测试验证各作用域实际计数、跨日月额度、SQL 绑定及密钥更新后的脱敏响应。

## Alternatives considered

仅对重复 Redis key 去重无法确定应采用哪套额度，也不能修复日/月限制混用。
仅修正 Provider 类型断言不能改变运行时的参数展开行为。

## Consequences

后续请求按各窗口独立扣算；既有 Redis 计数不回写，历史重复累计值需要等待
对应窗口自然过期。没有数据库迁移和新增配置，Provider API 结构保持一致。
