/** 仅在单个聚合请求内共享调度、取消和 GET 去重，不保存跨请求业务状态。 */
export class BffError extends Error {
  constructor(
    public statusCode: number,
    public data: { error: string; code?: string; request_id?: string },
    public headers: Record<string, string> = {},
  ) {
    super(data.error);
  }
}

export interface CoreReader {
  get<T>(path: string, options?: { timeout?: number; anonymous?: boolean }): Promise<T>;
}

/** 固定上游与 v1 路径，防止聚合器成为任意地址代理。 */
export function coreUrl(base: string, path: string): URL {
  const origin = new URL(base).origin;
  const url = new URL(path, origin);
  if (url.origin !== origin || !url.pathname.startsWith('/api/v1/') || /%(2e|2f|5c)/i.test(url.pathname)) {
    throw new BffError(400, { error: '无效的上游路径', code: 'BFF_INVALID_PATH' });
  }
  url.searchParams.sort();
  return url;
}

/** 构造有界并发读取器；超时涵盖排队时间，失败不自动重试。 */
export function createCoreReader(options: {
  base: string;
  token?: string;
  headers?: Record<string, string>;
  signal: AbortSignal;
  fetcher?: typeof fetch;
  concurrency?: number;
  onRequest?: () => void;
}): CoreReader {
  const fetcher = options.fetcher ?? fetch;
  const pending = new Map<string, Promise<unknown>>();
  const queue: (() => void)[] = [];
  let active = 0;
  const acquire = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (active < (options.concurrency ?? 4)) {
      active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = queue.indexOf(ready);
        if (index !== -1) queue.splice(index, 1);
        reject(signal.reason);
      };
      const ready = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      queue.push(ready);
      signal.addEventListener('abort', abort, { once: true });
    });
  };
  const release = () => {
    const next = queue.shift();
    if (next) next();
    else active--;
  };
  return {
    get<T>(path: string, request: { timeout?: number; anonymous?: boolean } = {}): Promise<T> {
      const url = coreUrl(options.base, path);
      const key = `${request.anonymous ? 'anonymous' : 'viewer'}:${url}`;
      const existing = pending.get(key);
      if (existing) return existing as Promise<T>;
      const promise = (async () => {
        const timeout = AbortSignal.timeout(request.timeout ?? 5000);
        const signal = AbortSignal.any([options.signal, timeout]);
        let acquired = false;
        try {
          await acquire(signal);
          acquired = true;
          signal.throwIfAborted();
          const headers = new Headers(options.headers);
          headers.delete('authorization');
          headers.delete('cookie');
          if (options.token && !request.anonymous) headers.set('authorization', `Bearer ${options.token}`);
          headers.set('accept', 'application/json');
          options.onRequest?.();
          const response = await fetcher(url, { headers, signal, redirect: 'manual' });
          const body = await response.json().catch(() => null);
          signal.throwIfAborted();
          if (!response.ok) {
            const forwarded: Record<string, string> = {};
            for (
              const name of [
                'retry-after',
                'x-request-id',
                'www-authenticate',
                'x-ratelimit-limit',
                'x-ratelimit-remaining',
                'x-ratelimit-reset',
              ]
            ) {
              const value = response.headers.get(name);
              if (value) forwarded[name] = value;
            }
            throw new BffError(response.status >= 300 && response.status < 400 ? 502 : response.status, {
              error: typeof body?.error === 'string' ? body.error : '上游服务请求失败',
              code: typeof body?.code === 'string' ? body.code : undefined,
              request_id: typeof body?.request_id === 'string' ? body.request_id : undefined,
            }, forwarded);
          }
          if (body === null) throw new BffError(502, { error: '上游响应格式无效', code: 'BFF_INVALID_RESPONSE' });
          return body as T;
        } catch (error) {
          if (error instanceof BffError) throw error;
          if (signal.aborted) throw new BffError(504, { error: '页面数据读取超时或已取消', code: 'BFF_TIMEOUT' });
          throw new BffError(502, { error: '页面数据服务暂时不可用', code: 'BFF_UPSTREAM_UNAVAILABLE' });
        } finally {
          if (acquired) release();
        }
      })();
      pending.set(key, promise);
      return promise;
    },
  };
}
