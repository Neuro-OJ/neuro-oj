/**
 * 请求上下文（AsyncLocalStorage）。
 *
 * 为日志与未来 trace_id 提供进程内上下文传播。
 * 实现放在 shared/observability kernel，避免 shared/base/logging 反向依赖 domain。
 *
 * ## 为什么这里是唯一的 ALS 实例
 *
 * LogTape 的 `contextLocalStorage` 会把 store 里的**全部键**并入每条日志的
 * `properties`，而格式化器只认契约键名 `request_id`（见 `log-format.ts` 的
 * `renderableFields` 与 `log-conventions.md` §4）。因此：
 *
 * - 存储的键名必须是 `request_id`，不能是 `requestId`；否则 `properties.request_id`
 *   恒为 undefined，格式化器渲染不出 `rid=`。
 * - 装配 `contextLocalStorage` 的实例必须与 `runWithRequestContext` 写入的实例
 *   是**同一个对象**，否则请求上下文根本不会出现在日志里。
 *
 * 为此本模块导出 `requestContextStorage` 供 `log-config.ts` 装配，取代此前
 * 各自 new 一个 AsyncLocalStorage 的写法（那会让 request_id 静默丢失）。
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** 上下文存储的键名（契约名，勿改为 camelCase）。 */
export const REQUEST_ID_KEY = "request_id";

/**
 * 请求上下文存储。
 *
 * 同时被 `runWithRequestContext`（写入）与 LogTape 的 `contextLocalStorage`（读取）
 * 使用，两边必须共用这一个实例。
 */
export const requestContextStorage = new AsyncLocalStorage<
  Record<string, unknown>
>();

export interface RequestContext {
  requestId: string;
}

/**
 * 在带有 request_id 的上下文中执行 `fn`。
 *
 * 由 request-context 中间件在每个 HTTP 请求最外层调用，
 * 使其内部（含 service 层）的所有 logger 调用自动附带同一 request_id。
 */
export function runWithRequestContext<T>(requestId: string, fn: () => T): T {
  return requestContextStorage.run(
    { [REQUEST_ID_KEY]: requestId },
    fn,
  );
}

/** 读取当前请求上下文的 request_id（不在请求上下文中时返回 undefined）。 */
export function getRequestId(): string | undefined {
  const value = requestContextStorage.getStore()?.[REQUEST_ID_KEY];
  return typeof value === "string" ? value : undefined;
}
