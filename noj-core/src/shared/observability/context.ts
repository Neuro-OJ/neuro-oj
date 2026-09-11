/**
 * 请求上下文（AsyncLocalStorage）。
 *
 * 为日志与未来 trace_id 提供进程内上下文传播。
 * 实现放在 shared/observability kernel，避免 shared/base/logging 反向依赖 domain。
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  requestId: string;
}

const requestStore = new AsyncLocalStorage<RequestContext>();

/**
 * 在带有 request_id 的上下文中执行 `fn`。
 *
 * 由 request-context 中间件在每个 HTTP 请求最外层调用，
 * 使其内部（含 service 层）的所有 logger 调用自动附带同一 request_id。
 */
export function runWithRequestContext<T>(requestId: string, fn: () => T): T {
  return requestStore.run({ requestId }, fn);
}

/** 读取当前请求上下文的 request_id（不在请求上下文中时返回 undefined）。 */
export function getRequestId(): string | undefined {
  return requestStore.getStore()?.requestId;
}
