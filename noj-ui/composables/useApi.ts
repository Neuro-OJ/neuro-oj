import type { ApiErrorInfo } from '~/utils/apiError';
import { extractApiError } from '~/utils/apiError';
import { useToast } from '~/composables/useToast';

/**
 * 统一 API 调用层。
 *
 * 封装 `$fetch`，非 2xx / 网络 / 超时错误时：
 * 1. 自动提取后端 `error` 字段（具体错误原因）并通过 `useToast().toast.error()` 弹窗；
 * 2. **原样重抛** 原错误对象（保留 `data`/`status` 结构），
 *    现有依赖错误对象属性（如 `e.data?.code === "USER_BANNED"`、404 分支）的代码不受影响。
 *
 * 选项：
 * - `silent: true`：不弹 toast（轮询、后台刷新、表单内联错误等场景），错误仍抛出
 * - `onError(err, info)`：自定义错误处理，提供后替换默认 toast；与 `silent` 同时给出时
 *   `silent` 优先（不弹窗，`onError` 仍执行）
 * - `timeout`（ms）：透传 ofetch `timeout`（内部 `AbortSignal.timeout`）
 *
 * SSR 端（`import.meta.server`）不弹 toast（UToaster 依赖客户端渲染），仅抛错。
 */

/** $fetch 选项类型（排除 method/timeout，二者由 useApi 接管） */
type FetchOptions = NonNullable<Parameters<typeof $fetch>[1]>;

/** API 调用选项：silent/onError 为 API 层专属，其余透传 $fetch */
export interface ApiCallOptions extends Omit<FetchOptions, 'method' | 'timeout'> {
  /** 静默模式：不弹 toast，错误仍抛出（由调用方处理） */
  silent?: boolean;
  /** 自定义错误处理：替换默认 toast；与 silent 同时给出时 silent 优先 */
  onError?: (err: unknown, info: ApiErrorInfo) => void;
  /** 请求超时（ms），透传 ofetch timeout */
  timeout?: number;
  /** 401 时是否跳转登录页；全局状态探测等匿名请求可显式关闭。 */
  redirectOnUnauthorized?: boolean;
}

type ApiMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export function useApi() {
  const { toast } = useToast();
  // 当前路由：401 时跳转登录页需要保留回跳目标（SSR 阶段不可跳转，仅客户端）
  const route = useRoute();

  // SSR 端 $fetch 不会自动携带浏览器 Cookie（server→server 直连）。
  // 使用 useRequestFetch 统一转发原始请求的 Cookie 与请求头，与 useFetch 行为对齐。
  // 客户端浏览器会自动带上 Cookie，无需注入。
  const serverFetch = import.meta.server ? useRequestFetch() : undefined;

  // 认证相关页面：其自身的 401（如登录失败）不应触发跳转，避免死循环
  const AUTH_PAGE_PREFIXES = ['/login', '/register', '/forgot-password', '/reset-password', '/change-password'];

  async function request<T = unknown>(
    method: ApiMethod,
    url: string,
    options: ApiCallOptions = {},
  ): Promise<T> {
    const { silent = false, onError, redirectOnUnauthorized = true, ...fetchOptions } = options;
    try {
      // SSR 使用 useRequestFetch 转发 Cookie/Headers；客户端使用普通 $fetch
      const fetcher = import.meta.server && serverFetch ? serverFetch : $fetch;
      return await fetcher<T>(url, { method, ...fetchOptions });
    } catch (err) {
      const info = extractApiError(err);
      if (import.meta.client && import.meta.dev) {
        console.error('[useApi] 请求失败', {
          method: method.toUpperCase(),
          url,
          status: info.status,
          code: info.code,
          requestId: info.requestId,
          message: info.message,
        });
      }
      // silent 只抑制默认 toast；onError 自定义回调仍执行（设计 D4）
      if (onError) {
        onError(err, info);
      } else if (!silent && import.meta.client) {
        toast.error(info.message);
      }
      // 未认证（401）：客户端统一跳转登录页并携带回跳目标。
      // SSR 阶段无法跳转，错误继续抛出，由 Nuxt 渲染错误页（生产为 HTML）。
      if (
        import.meta.client &&
        redirectOnUnauthorized &&
        info.status === 401 &&
        !AUTH_PAGE_PREFIXES.some((p) => route.path.startsWith(p))
      ) {
        // NOJ-210：统一 401 处理必须清掉僵尸登录态——
        // 本地 user state、可读 session cookie，以及 HTTP-only token cookie。
        const authUser = useState<unknown>('auth:user', () => null);
        authUser.value = null;
        try {
          const session = useCookie('noj:session');
          session.value = null;
        } catch {
          // ignore
        }
        void $fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
        const redirect = route.fullPath;
        navigateTo({ path: '/login', query: { redirect } });
      }
      // 原样重抛：保留 $fetch 错误对象结构，调用方分支代码零破坏
      throw err;
    }
  }

  return {
    api: {
      get: <T = unknown>(url: string, options?: ApiCallOptions) => request<T>('get', url, options),
      post: <T = unknown>(url: string, body?: unknown, options?: ApiCallOptions) =>
        request<T>('post', url, { body, ...options }),
      put: <T = unknown>(url: string, body?: unknown, options?: ApiCallOptions) =>
        request<T>('put', url, { body, ...options }),
      patch: <T = unknown>(url: string, body?: unknown, options?: ApiCallOptions) =>
        request<T>('patch', url, { body, ...options }),
      delete: <T = unknown>(url: string, options?: ApiCallOptions) => request<T>('delete', url, options),
    },
  };
}
