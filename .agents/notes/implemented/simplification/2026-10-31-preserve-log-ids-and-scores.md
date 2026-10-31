# Agent Note: 生产日志保留业务 ID 与分数

Status: implemented

## Problem

#698 指出生产日志截断业务 ID、隐藏 score，导致排障无法关联数据库、Core、Judge
和网关记录。

## Decision

Core 与网关日志均删除 ID 截断规则、request_id 特例及 score 隐藏，移除无人使用的
redactId 导出。结构化字段、消息插值和嵌套对象保留完整 ID
与分数，敏感内容继续脱敏；网关既有 IP
脱敏保持。同步生产日志规范、测试和跨运行时一致性检查，UUID 不再用作敏感哨兵。

## Alternatives considered

只放行 request_id 无法串联业务实体。此次不合并两套日志实现，避免扩大变更。

## Consequences

生产日志能直接关联业务记录、查看分数；代码、令牌、密钥和密码仍被抹除。开发
pretty 格式的请求标识缩写仅用于列宽展示。

验证：Core 共享日志测试 45 项、网关逻辑测试 143
项全部通过；两端类型检查、修改文件格式与 lint、9 组跨运行时渲染一致性夹具及
Agent Note 校验通过。
