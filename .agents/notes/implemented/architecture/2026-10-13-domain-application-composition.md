# Agent Note: 显式域业务接入应用组合根

Status: implemented

## Problem

各模块单独验证的显式域路由需要在实际应用一起运行。共用 API
前缀的通配认证会误拦其他模块的公开端点，客户端幂等键也需要通过 CORS 预检。

## Decision

组合根接入域题库、题单、共享管理、普通及客观提交、任务、本人历史、比赛、社区、统计、搜索、LLM
和教学路由。认证和缓存中间件限定在自己的路径，SSE 同样按具体事件路径认证。CORS
明确允许 Idempotency-Key。

实际 createApp 测试覆盖匿名公开入口、双域不同教学身份、私有域访问、已知 ID
放入错误域、旧兼容入口及移除后的受控本人历史。本人历史不恢复题面，也不授予教师跨域提交读取能力。

## Alternatives considered

不通过路由注册先后掩盖通配认证污染，也不为组合测试单独构造一套假应用。直接验证生产
createApp 的中间件和路由顺序。

## Consequences

workspace 标准测试 PGlite 35 项通过、8 项 PostgreSQL 专用忽略，隔离 PostgreSQL
43 项通过，无失败。域边界、类型和相关 lint
通过。接入应用不等于已完成发布；完整模块回归、浏览器、Judge、性能及恢复验收仍在实施。
