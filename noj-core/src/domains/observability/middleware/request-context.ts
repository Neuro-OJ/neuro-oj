/**
 * 请求上下文中间件。
 *
 * 为每个 HTTP 请求生成唯一 `request_id`，并：
 * 1. 写入 Hono context（`c.set("requestId", id)`），供 onError 复用。
 * 2. 用 `runWithRequestContext` 包裹后续处理，使日志自动附带同一 request_id。
 */

import type { Context, Next } from "hono";
import { runWithRequestContext } from "../../../shared/observability/context.ts";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

export function requestContext(c: Context, next: Next): Promise<void> {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("X-Request-Id", requestId);
  return runWithRequestContext(requestId, () => next());
}
