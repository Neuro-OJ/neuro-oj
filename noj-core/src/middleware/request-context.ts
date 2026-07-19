/**
 * 请求上下文中间件。
 *
 * 为每个 HTTP 请求生成唯一 `request_id`，并：
 * 1. 写入 Hono context（`c.set("requestId", id)`），供 onError 复用，
 *    使错误响应里的 `request_id` 与服务端日志一致。
 * 2. 用 `runWithRequestContext` 包裹后续处理，使请求生命周期内
 *    （含 service 层）的所有 logger 调用自动附带同一 `request_id`，
 *    无需逐层透传参数。
 *
 * 应在 app.ts 中尽量靠外层注册（CORS 之后、业务中间件之前）。
 */

import type { Context, Next } from "hono";
import { runWithRequestContext } from "../lib/logging.ts";

// 全局声明 requestId 上下文变量，使任意 Hono 实例都能 c.get/c.set("requestId")
declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

export function requestContext(c: Context, next: Next): Promise<void> {
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  return runWithRequestContext(requestId, () => next());
}
