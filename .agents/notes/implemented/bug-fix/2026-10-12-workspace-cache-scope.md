# Agent Note: 工作空间缓存中间件限定模块路径

Status: implemented

## Problem

真实 PostgreSQL 全量回归发现比赛成绩导出的 `private, no-store` 被改成
`no-store`。工作空间 router 的通配中间件挂在 `/api/v1` 后也匹配了其他模块，
导致一个模块覆盖另一模块已声明的响应契约。

## Decision

将 no-store / Vary 中间件注册到空间目录、域内资源、本人空间偏好、邀请认证及
实例治理路径，不注册 `/api/v1/*` 全局通配。保留比赛导出原有缓存头，新增
挂载测试同时断言空间接口禁止缓存、其他模块响应头不被覆盖。

## Alternatives considered

- 修改比赛导出断言接受 no-store：会弱化原契约并保留模块越界，拒绝采用。
- 全站强制同一缓存政策：公开静态资源和私有成绩的缓存用途不同，按入口负责。

## Consequences

workspace 标准测试 27 项通过，contest 既有回归 94 项通过、1 项跳过。
本项不改变任何赛制计算或公开成绩规则；全量并行和新五赛制验收仍分别记录。
