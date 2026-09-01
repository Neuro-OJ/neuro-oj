# Agent Note: 生成式事件/路由目录

Status: implemented

## Problem

SSE 频道和 API 路由分散在多个文件，文档靠手写容易漂移。

## Decision

新增两个生成器：

- `scripts/gen-event-catalog.ts`：从 `event-bus.ts` 的 `Channels` 与 `publishEvent` 调用点生成 `dev-docs/engineering/event-catalog.md`。
- `scripts/gen-route-catalog.ts`：从 `noj-core/src/routes/*.ts` 提取 Hono 路由生成 `dev-docs/engineering/route-catalog.md`。

两者均支持 `--check`，并已加入 `check-ci.ts` / `check-all.ts`，CI 会拒绝过期目录。

## Alternatives considered

- 手写目录：必然漂移。
- 使用第三方 OpenAPI 生成：当前 Hono 路由未统一声明 schema，收益/成本不划算。

## Consequences

- 新增/修改频道或路由时，CI 会提示重新生成目录。
- 目录与源码保持一致。
