/**
 * 测试公共辅助函数（issue #99 引入，与 PR #90 helper 合并版一致）。
 */
import type { Hono } from "hono";

/**
 * 创建 Hono 测试请求并执行。
 * 返回 Response 对象，支持设置 JWT token 和模拟 IP。
 */
export function jsonRequest(
  app: Hono,
  path: string,
  opts: {
    method?: string;
    body?: Record<string, unknown>;
    token?: string;
    ip?: string;
  } = {},
): Response | Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  if (opts.ip) headers["X-Forwarded-For"] = opts.ip;
  const req = new Request(`http://localhost${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return app.fetch(req);
}
