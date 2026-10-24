import type { ResourceError } from './types.ts';

export class ApiError extends Error {
  constructor(public readonly info: ResourceError, public readonly data?: unknown) {
    super(info.message);
    this.name = 'ApiError';
  }
}

export function errorInfo(error: unknown): ResourceError {
  if (error instanceof ApiError) return error.info;
  // SSR 传输层保留 ofetch 的错误结构，客户端统一为 ApiError。
  const value = error as { status?: number; statusCode?: number; data?: Record<string, unknown> } | undefined;
  return {
    message: typeof value?.data?.error === 'string' ? value.data.error : '请求失败，请检查网络后重试',
    status: value?.status ?? value?.statusCode ?? 0,
    code: typeof value?.data?.code === 'string' ? value.data.code : undefined,
    requestId: typeof value?.data?.request_id === 'string' ? value.data.request_id : undefined,
  };
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeout?: number;
  silent?: boolean;
}

/** 与既有登录契约保持一致：未输入动态码时省略 code，未勾选记住我时省略 remember。 */
export function loginPayload(credentials: { login: string; password: string; code?: string; remember?: boolean }) {
  const code = credentials.code?.trim();
  return {
    login: credentials.login.trim(),
    password: credentials.password,
    ...(code ? { code } : {}),
    ...(credentials.remember ? { remember: true } : {}),
  };
}

/** 只调用同源代理；Cookie 由浏览器携带，React 从不读取 JWT。 */
export async function request<T>(
  url: string,
  options: RequestOptions & { method?: string; body?: unknown } = {},
): Promise<T> {
  if (!url.startsWith('/api/v1/') && url !== '/api/auth/logout') {
    throw new ApiError({ status: 0, message: '无效的 API 路径' });
  }
  const timeout = AbortSignal.timeout(options.timeout ?? 15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const multipart = options.body instanceof FormData;
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      credentials: 'same-origin',
      headers: options.body !== undefined && !multipart ? { 'content-type': 'application/json' } : undefined,
      body: options.body === undefined
        ? undefined
        : multipart
        ? options.body as FormData
        : JSON.stringify(options.body),
      signal,
    });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError({
        status: response.status,
        message: typeof data?.error === 'string' ? data.error : `请求失败（${response.status}）`,
        code: typeof data?.code === 'string' ? data.code : undefined,
        requestId: data?.request_id ?? response.headers.get('x-request-id') ?? undefined,
      }, data);
    }
    if (data === null && response.status !== 204) {
      throw new ApiError({ status: response.status, message: '服务响应格式无效，请重试' });
    }
    return data as T;
  } catch (error) {
    if (error instanceof ApiError || options.signal?.aborted) throw error;
    throw new ApiError({ status: 0, message: timeout.aborted ? '请求超时，请重试' : '网络连接失败，请重试' });
  }
}
