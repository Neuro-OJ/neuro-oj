/**
 * API 错误提取工具（纯函数，无 Nuxt/`import.meta` 依赖，可独立单元测试）。
 *
 * 统一从 `$fetch` 抛出的任意异常中提取「展示给用户的具体错误原因」，
 * 避免各调用点重复编写 `e.data?.error || e.status` 之类的提取逻辑、
 * 以及只显示状态码丢失具体原因的问题。
 */

/** 提取结果：可直接用于 toast/表单错误展示 */
export interface ApiErrorInfo {
  /** 展示给用户的具体错误原因（优先为后端 `error` 字段，否则为兜底文案） */
  message: string;
  /** 后端错误码（如 VALIDATION_ERROR、CONFLICT_ERROR），无则 undefined */
  code?: string;
  /** HTTP 状态码（网络/超时等无响应错误时为 undefined） */
  status?: number;
  /** 后端 request_id（用于与服务端日志关联），无则 undefined */
  requestId?: string;
}

// 兜底文案集中管理：网络/超时/未知错误不允许展示原始英文堆栈
const FALLBACK_NETWORK = '网络连接失败，请检查网络';
const FALLBACK_TIMEOUT = '请求超时，请稍后重试';
const FALLBACK_UNKNOWN = '操作失败，请稍后重试';

/** 判断是否为超时/中止错误（ofetch `timeout` 选项或 AbortController.abort 触发） */
export function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true;
  const cause = (err as { cause?: unknown }).cause;
  return cause instanceof Error && cause.name === 'AbortError';
}

/** 判断是否为网络层错误（请求未到达后端，如 fetch failed / Failed to fetch） */
export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof TypeError) return true;
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof TypeError) return true;
  const msg = err.message ?? '';
  return msg.includes('fetch failed') || msg.includes('Failed to fetch') ||
    msg.includes('NetworkError');
}

/**
 * 从任意异常提取错误信息。
 *
 * 提取优先级：
 * 1. 后端错误响应（`data.error` 字符串）——具体原因，直接展示
 * 2. 超时（AbortError）→ 「请求超时，请稍后重试」
 * 3. 网络错误（TypeError/fetch failed）→ 「网络连接失败，请检查网络」
 * 4. 有 HTTP 状态码但无 error 字段 → 「请求失败（HTTP <status>）」
 * 5. 未知错误 → 「操作失败，请稍后重试」
 */
export function extractApiError(err: unknown): ApiErrorInfo {
  const e = err as {
    data?: unknown;
    status?: number;
    statusCode?: number;
    response?: { status?: number };
  } | null;

  const status = e?.status ?? e?.statusCode ?? e?.response?.status;

  // 1. 后端错误响应：响应体 `{ error: string, code, request_id }`
  const data = e?.data;
  if (data !== null && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (typeof d.error === 'string' && d.error.length > 0) {
      return {
        message: d.error,
        code: typeof d.code === 'string' ? d.code : undefined,
        status,
        requestId: typeof d.request_id === 'string' ? d.request_id : undefined,
      };
    }
  }

  // 2. 超时
  if (isTimeoutError(err)) return { message: FALLBACK_TIMEOUT, status };
  // 3. 网络错误
  if (isNetworkError(err)) return { message: FALLBACK_NETWORK, status };
  // 4. 有状态码但响应体无 error 字段：给出结构化兜底而非裸状态码
  if (typeof status === 'number') return { message: `请求失败（HTTP ${status}）`, status };
  // 5. 未知错误
  return { message: FALLBACK_UNKNOWN };
}
