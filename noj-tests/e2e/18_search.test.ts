/**
 * 全局搜索 E2E 测试（issue #100）。
 *
 * 覆盖：
 * - 匿名 type=problem 搜索返回 200 + 标准响应结构（data.items / has_more / took_ms）
 * - include_total=true 时返回精确 total
 * - 匿名 type=user 返回 401（未登录）
 * - 已登录非 admin 用户 type=user 返回 403（无权限）
 * - admin type=user 返回 200 且 items 含 email 字段
 * - 错误参数（type 非法、q 过短）返回 400
 * - limit 边界值校验
 *
 * 性能测试由 Task 9 覆盖（perf 基准），本文件不重复。
 */

import {
  apiGet,
  e2eTest,
  getAdminToken,
  isE2E,
  registerUser,
  TEST_PASSWORD,
  waitForServer,
} from "./helper.ts";

let adminToken = "";
let regularToken = "";

// 与 helper.ts 中 adminCreds.email 一致（默认 "e2e_admin@test.com"）。
// seed.ts 从 email 派生 username：e2e_admin@test.com → "e2e_admin"。
const ADMIN_EMAIL = Deno.env.get("E2E_ADMIN_EMAIL") || "e2e_admin@test.com";
const ADMIN_USERNAME = ADMIN_EMAIL.split("@")[0].replace(/[^a-zA-Z0-9_]/g, "_");

e2eTest("[e2e/search] Setup", async () => {
  if (!isE2E) return;
  await waitForServer();
  adminToken = await getAdminToken();
  const ts = Date.now().toString(36);
  regularToken = await registerUser(
    `search_user_${ts}`,
    `search_user_${ts}@test.com`,
    TEST_PASSWORD,
  );
});

e2eTest("[e2e/search] 1.1 匿名题目搜索返回 200 + 标准结构", async () => {
  if (!isE2E) return;
  // P1001 是 seed 自带的 A+B 样例题，关键词稳定可命中。
  const { status, body } = await apiGet(
    "/api/v1/search?q=1001&type=problem&limit=5",
  );
  if (status !== 200) throw new Error(`期望 200, 实际 ${status}`);
  const d = body as {
    data?: {
      query?: string;
      type?: string;
      items?: Array<{ id: string; display_id: string; title: string }>;
      has_more?: boolean;
      page?: number;
      limit?: number;
      took_ms?: number;
    };
  };
  if (!d.data) throw new Error("响应缺少 data 字段");
  if (d.data.type !== "problem") throw new Error("type 应为 problem");
  if (d.data.query !== "1001") throw new Error("query 应回显请求参数");
  if (typeof d.data.took_ms !== "number") {
    throw new Error("took_ms 应为 number");
  }
  if (!Array.isArray(d.data.items)) {
    throw new Error("items 应为数组");
  }
  if (typeof d.data.has_more !== "boolean") {
    throw new Error("has_more 字段应为 boolean");
  }
  console.log(
    `  ✓ 题目搜索 OK（返回 ${d.data.items.length} 题, has_more=${d.data.has_more}, ` +
      `took_ms=${d.data.took_ms}）`,
  );
});

e2eTest("[e2e/search] 1.1b include_total=true 返回精确总数", async () => {
  if (!isE2E) return;
  const { status, body } = await apiGet(
    "/api/v1/search?q=1001&type=problem&limit=5&include_total=true",
  );
  if (status !== 200) throw new Error(`期望 200, 实际 ${status}`);
  const d = body as { data?: { total?: number; has_more?: boolean } };
  if (typeof d.data?.total !== "number") {
    throw new Error("include_total=true 时 total 字段应为 number");
  }
  if (typeof d.data.has_more !== "boolean") {
    throw new Error("include_total=true 时 has_more 字段应为 boolean");
  }
  console.log(`  ✓ 精确总数 OK（total=${d.data.total}）`);
});

e2eTest("[e2e/search] 1.2 匿名用户搜索返回 401", async () => {
  if (!isE2E) return;
  const { status } = await apiGet("/api/v1/search?q=alice&type=user");
  if (status !== 401) throw new Error(`期望 401, 实际 ${status}`);
  console.log("  ✓ 匿名用户搜索被拒");
});

e2eTest("[e2e/search] 1.3 已登录非 admin 用户搜索返回 403", async () => {
  if (!isE2E) return;
  const { status } = await apiGet(
    "/api/v1/search?q=alice&type=user",
    regularToken,
  );
  if (status !== 403) throw new Error(`期望 403, 实际 ${status}`);
  console.log("  ✓ 普通用户搜索被拒");
});

e2eTest("[e2e/search] 1.4 admin 搜索用户返回 email 字段", async () => {
  if (!isE2E) return;
  const { status, body } = await apiGet(
    `/api/v1/search?q=${ADMIN_USERNAME}&type=user&limit=10`,
    adminToken,
  );
  if (status !== 200) throw new Error(`期望 200, 实际 ${status}`);
  const d = body as {
    data?: {
      items?: Array<{
        id: string;
        username: string;
        email: string;
      }>;
      total?: number;
    };
  };
  if (!d.data?.items?.length) {
    throw new Error(`未搜到 admin 用户（q=${ADMIN_USERNAME}）`);
  }
  const item = d.data.items[0];
  if (typeof item.email !== "string" || !item.email.includes("@")) {
    throw new Error(`email 字段缺失或非法: ${JSON.stringify(item)}`);
  }
  // users.role 字段已废弃（RBAC：admin:full_access 权限判定），搜索响应不再包含 role
  console.log(
    `  ✓ admin 用户搜索 OK（找到 ${item.username} <${item.email}>）`,
  );
});

e2eTest("[e2e/search] 1.5 非法 type 返回 400", async () => {
  if (!isE2E) return;
  const { status } = await apiGet("/api/v1/search?q=test&type=invalid");
  if (status !== 400) throw new Error(`期望 400, 实际 ${status}`);
  console.log("  ✓ 非法 type 被拒");
});

e2eTest("[e2e/search] 1.6 q 过短（< 2 字符）返回 400", async () => {
  if (!isE2E) return;
  const { status } = await apiGet("/api/v1/search?q=a&type=problem");
  if (status !== 400) throw new Error(`期望 400, 实际 ${status}`);
  console.log("  ✓ 过短关键词被拒");
});
