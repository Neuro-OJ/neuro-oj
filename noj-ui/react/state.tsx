/** @jsxImportSource react */
/** @jsxRuntime automatic */
import { toast } from 'sonner';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { PropsWithChildren } from 'react';
import { ApiError, errorInfo, request } from './api.ts';
import type { RequestOptions } from './api.ts';
import type { Bootstrap, ResourceError, ResourceSnapshot, User } from './types.ts';

interface Api {
  get: <T>(url: string, options?: RequestOptions) => Promise<T>;
  post: <T>(url: string, body?: unknown, options?: RequestOptions) => Promise<T>;
}

interface State {
  user: User | null;
  authError?: ResourceError;
  setUser: (user: User | null) => void;
  retryAuth: () => Promise<void>;
  api: Api;
  initial: Record<string, ResourceSnapshot>;
}

const StateContext = createContext<State | null>(null);

export function StateProvider({ bootstrap, children }: PropsWithChildren<{ bootstrap: Bootstrap }>) {
  const [user, setUser] = useState(bootstrap.user);
  const [authError, setAuthError] = useState(bootstrap.authError);
  const call = useCallback(
    async <T,>(url: string, options: RequestOptions & { method?: string; body?: unknown } = {}) => {
      try {
        return await request<T>(url, options);
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const info = errorInfo(error);
        if (info.status === 401 && url !== '/api/v1/auth/login') setUser(null);
        if (!options.silent) toast.error(info.message);
        throw error;
      }
    },
    [],
  );
  const api = useMemo<Api>(() => ({
    get: (url, options) => call(url, options),
    post: (url, body, options) => call(url, { ...options, method: 'POST', body }),
  }), [call]);
  const retryAuth = useCallback(async () => {
    try {
      const response = await api.get<{ data: User }>('/api/v1/auth/me', { silent: true, timeout: 5000 });
      setUser(response.data);
      setAuthError(undefined);
    } catch (error) {
      const info = errorInfo(error);
      setAuthError(info.status === 401 ? undefined : info);
      if (info.status === 401) setUser(null);
    }
  }, [api]);
  const value = useMemo(() => ({ user, authError, setUser, retryAuth, api, initial: bootstrap.resources }), [
    user,
    authError,
    retryAuth,
    api,
    bootstrap.resources,
  ]);
  return <StateContext.Provider value={value}>{children}</StateContext.Provider>;
}

export function useAppState(): State {
  const value = useContext(StateContext);
  if (!value) throw new Error('React 页面必须置于 StateProvider 内');
  return value;
}

export function useResource<T>(url: string | null) {
  const { api, initial } = useAppState();
  const [revision, setRevision] = useState(0);
  const busy = useRef(false);
  const [state, setState] = useState<{ key: string | null; data?: T; error?: ResourceError; loading: boolean }>(() => ({
    key: url,
    data: url ? initial[url]?.data as T | undefined : undefined,
    error: url ? initial[url]?.error : undefined,
    loading: Boolean(url && !initial[url]),
  }));
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    busy.current = true;
    setState((previous) => ({
      key: url,
      data: previous.key === url ? previous.data : initial[url]?.data as T | undefined,
      loading: true,
    }));
    void api.get<T>(url, { signal: controller.signal, silent: true }).then((data) => {
      if (!controller.signal.aborted) setState({ key: url, data, loading: false });
    }).catch((error) => {
      if (!controller.signal.aborted) {
        setState((previous) => ({ ...previous, key: url, error: errorInfo(error), loading: false }));
      }
    }).finally(() => {
      if (!controller.signal.aborted) busy.current = false;
    });
    return () => {
      controller.abort();
      busy.current = false;
    };
  }, [url, revision, api, initial]);
  // 切换 URL 的首帧只展示新路径的 SSR 数据，绝不借用上一道题的内容。
  const visible = state.key === url
    ? state
    : { data: url ? initial[url]?.data as T | undefined : undefined, error: undefined, loading: Boolean(url) };
  const refresh = useCallback(() => {
    if (!busy.current) setRevision((value) => value + 1);
  }, []);
  return { data: visible.data, error: visible.error, loading: visible.loading, refresh };
}

/** SSE 推动刷新，连接不可用时轮询兜底；终态与卸载都会关闭连接和定时器。 */
export function useLiveRefresh(url: string | null, active: boolean, refresh: () => void) {
  const callback = useRef(refresh);
  callback.current = refresh;
  useEffect(() => {
    if (!active || !url) return;
    const events = new EventSource(`${url}/events`);
    const update = () => callback.current();
    events.addEventListener('submission:updated', update);
    events.addEventListener('self-test:updated', update);
    events.onmessage = update;
    const timer = globalThis.setInterval(update, 2000);
    return () => {
      globalThis.clearInterval(timer);
      events.close();
    };
  }, [url, active]);
}

export function versionConflict(error: unknown): boolean {
  return error instanceof ApiError && error.info.status === 409 && (
    error.info.code?.includes('VERSION') === true || error.info.code?.includes('REVISION') === true
  );
}
