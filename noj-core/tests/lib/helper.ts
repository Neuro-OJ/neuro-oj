/**
 * 测试公共辅助函数（issue #99 引入，与 PR #90 helper 合并版一致）。
 */

/** jsonRequest 选项包 */
export interface JsonRequestOptions {
  method?: string;
  body?: unknown;
  /** 自动拼 'Bearer ' 前缀；显式提供 Authorization 时跳过 */
  token?: string;
  /** 用于触发或绕过基于 IP 的限流 */
  ip?: string;
  /** 自定义 header（覆盖默认），用于中间件测试 */
  headers?: Record<string, string>;
}

/**
 * 构造带 JSON body 的 fetch Request 并通过 app.fetch() 调用 Hono 路由。
 * 与生产 hono/serve 路径一致，避免测试用 app.request(path, init) 直写时的 fallback。
 */
export async function jsonRequest(
  app: { fetch: (req: Request) => Promise<Response> | Response },
  path: string,
  options: JsonRequestOptions = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers ?? {}),
  };
  if (
    options.token !== undefined && !("Authorization" in (options.headers ?? {}))
  ) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }
  if (options.ip !== undefined) {
    headers["X-Forwarded-For"] = options.ip;
  }

  const init: RequestInit = {
    method: options.method ?? "GET",
    headers,
  };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }

  return await app.fetch(new Request(`http://localhost${path}`, init));
}
