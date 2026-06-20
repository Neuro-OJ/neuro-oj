/**
 * E2E 测试辅助函数。
 *
 * 测试连接外部运行的 noj-core 服务器，不做服务器生命周期管理。
 *
 * 使用方式：
 *   1. 启动 noj-core 服务器（含迁移 + seed）
 *   2. NOJ_RUN_E2E=1 deno test -A tests/e2e/
 *
 * 环境变量：
 *   NOJ_RUN_E2E      - 设为 "1" 时启用 E2E 测试
 *   E2E_BASE_URL     - noj-core 服务地址（默认 http://localhost:8099）
 *   E2E_ADMIN_EMAIL  - 管理员邮箱（默认 e2e_admin@test.com）
 *   E2E_ADMIN_PASS   - 管理员密码（默认 e2e_admin_pass）
 */

export const isE2E = Deno.env.get("NOJ_RUN_E2E") === "1";
export const BASE_URL = Deno.env.get("E2E_BASE_URL") || "http://localhost:8099";
export const ADMIN_EMAIL = Deno.env.get("E2E_ADMIN_EMAIL") ||
  "e2e_admin@test.com";
export const ADMIN_PASS = Deno.env.get("E2E_ADMIN_PASS") || "e2e_admin_pass";

/**
 * 发送 HTTP 请求并返回 JSON 响应。
 */
export async function api(
  method: string,
  path: string,
  options?: {
    body?: unknown;
    token?: string;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options?.headers,
  };

  if (options?.token) {
    headers["Authorization"] = `Bearer ${options.token}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  return { status: res.status, body };
}

// ——— 简化方法 ———

export function apiGet(path: string, token?: string) {
  return api("GET", path, { token });
}

export function apiPost(path: string, body: unknown, token?: string) {
  return api("POST", path, { body, token });
}

export function apiPut(path: string, body: unknown, token?: string) {
  return api("PUT", path, { body, token });
}

export function apiPatch(path: string, body: unknown, token?: string) {
  return api("PATCH", path, { body, token });
}

export function apiDelete(path: string, token?: string) {
  return api("DELETE", path, { token });
}

// ——— 用户辅助 ———

/**
 * 注册用户并返回 token。
 */
export async function registerUser(
  username: string,
  email: string,
  password: string,
): Promise<string> {
  const res = await apiPost("/api/v1/auth/register", {
    username,
    email,
    password,
  });

  if (res.status !== 201) {
    // 可能已存在，尝试登录
    const loginRes = await apiPost("/api/v1/auth/login", {
      login: email,
      password,
    });
    if (loginRes.status === 200) {
      return (loginRes.body as { data: { token: string } }).data.token;
    }
    throw new Error(
      `注册失败: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }

  // 注册成功后调登录拿 token（注册接口不返回 token）
  const loginRes = await apiPost("/api/v1/auth/login", {
    login: email,
    password,
  });
  if (loginRes.status !== 200) {
    throw new Error(
      `注册成功但登录失败: ${loginRes.status} ${JSON.stringify(loginRes.body)}`,
    );
  }
  return (loginRes.body as { data: { token: string } }).data.token;
}

/**
 * 登录用户返回 token。
 */
export async function loginUser(
  login: string,
  password: string,
): Promise<string> {
  const res = await apiPost("/api/v1/auth/login", { login, password });
  if (res.status !== 200) {
    throw new Error(
      `登录失败: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return (res.body as { data: { token: string } }).data.token;
}

/**
 * 等待服务器就绪并预热数据库和 HTTP 连接。
 * 预热所有常用表和 POST 路由，避免冷启动导致测试超时。
 */
export async function waitForServer(
  retries = 30,
  intervalMs = 500,
): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`${BASE_URL}/health`);
      if (r.ok) {
        // 预热：访问所有常用表，让 PostgreSQL 缓存到 shared_buffers
        const warmupEndpoints = [
          "/api/v1/problems",
          "/api/v1/categories",
        ];
        for (const ep of warmupEndpoints) {
          try {
            const wr = await fetch(`${BASE_URL}${ep}`);
            await wr.text();
          } catch {
            // 预热请求失败不影响后续测试
          }
        }
        // 预热：发一个 POST 请求，避免 Deno.serve 第二个 POST 卡 7s
        try {
          const wr = await fetch(`${BASE_URL}/api/v1/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ login: "warmup", password: "warmup" }),
          });
          await wr.text();
        } catch {
          // 预热请求失败不影响后续测试
        }
        return;
      }
    } catch {
      // 未就绪
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(
    `E2E 服务器 ${BASE_URL} 未就绪（重试 ${retries} 次）`,
  );
}
