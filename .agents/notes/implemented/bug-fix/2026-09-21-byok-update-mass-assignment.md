# Agent Note: BYOK Provider 更新路径允许改写 enabled / 负 cost（越权与配额退款）

Status: implemented

## Problem

两条路径叠加造成字段级授权缺失（mass assignment）：

1. `noj-core` 的用户路由 `PUT /api/v1/users/me/llm-providers/:id`
   （`src/domains/identity/routes/users.ts`）把**整个请求体**原样转发给
   gateway：

   ```ts
   const body = await parseJsonBody<
     Partial<{ name: string; base_url: string; model: string; api_key: string }>
   >(c);
   await updateUserLlmProvider(userId, id, body);   // JSON.stringify(body) 全量转发
   ```

   TypeScript 泛型在运行时被擦除，路由没有做字段过滤。

2. `noj-llm-gateway` 的 `updateProvider`（`src/providers.ts`）按字段名取值，
   `enabled` 与 `cost_per_1k_tokens` 都在可写集合里，且 **cost 无任何范围校验**。

触发条件：普通登录用户对自己的 BYOK Provider 发

```http
PUT /api/v1/users/me/llm-providers/<id>
{ "enabled": true }
```

- `llm.ts` 在 `!providerSecret.provider.enabled` 时拒绝调用；该字段属管理面
  （管理员禁用某用户的 Provider），用户可自行解禁绕过。

```http
PUT /api/v1/users/me/llm-providers/<id>
{ "cost_per_1k_tokens": -100000 }
```

- `estimateCost` 由该单价产生负成本；
- `enforceAndCount` / `settleUsage` 的 Lua 用 `INCRBY` 累加，
  负值会**减少** user / global / problem 的共享 cost 计数器——用户可以用
  自己的请求为**全局**成本配额"退款"，绕过 `max_cost` 限额。

对照：创建路径（`users.ts` 的 POST）使用显式字面量对象，**不含**这两项；
`validateByokFields` 也只校验 `name` / `model` / `api_key`。两条路径的行为
不对称，说明更新路径是疏漏而非设计。

实测（修复前，`noj-llm-gateway` 单测复现）：

```
providers: BYOK 更新拒绝 enabled（用户不得自行解禁） ... FAILED
error: Error: expected provider_invalid
providers: BYOK 更新拒绝负 cost（防止配额退款） ... FAILED
error: Error: expected provider_invalid for -1
```

## Decision

在 gateway 的 `updateProvider` 中做两件事（gateway 不假设上游一定过滤）：

1. **BYOK 字段白名单**：`created_by !== "0"` 的行，只接受
   `name` / `base_url` / `model` / `api_key`；任何其它字段（含 `enabled`、
   `cost_per_1k_tokens`）一律 `provider_invalid`。
2. **cost 范围校验**（对**所有**来源）：必须为有限数且落在
   `[0, 1_000_000]`，拒绝负值与荒谬大值。

管理员/运维创建的 Provider（`created_by === "0"`）行为完全不变，仍可改
`enabled` 与 cost。

回归用例（`noj-llm-gateway/tests/providers_test.ts`）新增 4 条：BYOK 拒绝
`enabled`、BYOK 拒绝负 cost、BYOK 白名单字段仍可更新、管理员行仍可改
`enabled`/cost。

## Alternatives considered

1. **只在 core 路由做字段过滤**：拒绝。core 到 gateway 是服务间调用，gateway
   不应把安全不变量托付给上游；且 gateway 的 `/internal/*` 在其它调用方接入时
   会重新暴露同一问题。两侧都应有约束（core 侧已由网关白名单兜住语义）。
2. **把 `enabled` 改成仅 admin 可写、`cost` 仍允许用户设（仅加下界 0）**：
   部分采纳——但 cost 对 BYOK 用户本就无意义（BYOK 用自己的 key，不应影响共享
   配额核算），保留可写会持续存在"用户输入影响全局计数器"的面。故一并从 BYOK
   白名单移除；管理员路径不受影响。
3. **在创建路径也禁止 cost/enabled**：无需改动。创建路径本就不接受这两项
   （显式字面量对象），本次仅补齐更新路径。

## Consequences

- 普通用户无法再解禁被管理员禁用的 Provider，也无法写入负单价；
- 管理员/运维的 Provider 管理行为不变；
- 这是**收紧授权与输入校验**，不改动成功响应的结构或状态码（非法字段返回
  既有 `400 provider_invalid`），无需人工裁决。
