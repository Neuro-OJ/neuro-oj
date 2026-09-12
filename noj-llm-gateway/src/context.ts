/**
 * 请求上下文（AsyncLocalStorage）。
 *
 * 与 noj-core 的 `shared/observability/context.ts` 语义一致，但**独立实现**：
 * 两个 Deno 模块各自部署，跨模块相对导入会破坏 exports 边界。
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";

/** LogTape 读取的上下文字段名。 */
export const REQUEST_ID_KEY = "request_id";

const store = new AsyncLocalStorage<Record<string, unknown>>();

/** 供 LogTape 的 `contextLocalStorage` 使用。 */
export const gatewayContextStorage = store;

/** 在带 `request_id` 的上下文中执行 `fn`。 */
export function runWithRequestId<T>(requestId: string, fn: () => T): T {
  return store.run({ [REQUEST_ID_KEY]: requestId }, fn);
}

/** 读取当前 `request_id`（不在请求上下文中时返回 undefined）。 */
export function getRequestId(): string | undefined {
  const v = store.getStore()?.[REQUEST_ID_KEY];
  return typeof v === "string" ? v : undefined;
}

/**
 * 生成或透传 `X-Request-Id`，并用其包裹后续处理。
 *
 * 透传客户端提供的 ID 便于跨服务串联；无则生成 UUID。
 */
export function requestIdMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const requestId = incoming && incoming.length > 0 && incoming.length <= 128
      ? incoming
      : crypto.randomUUID();
    c.header("X-Request-Id", requestId);
    return await runWithRequestId(requestId, () => next());
  };
}
