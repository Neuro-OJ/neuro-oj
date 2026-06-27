/**
 * 每日签到 E2E 测试（issue #? 评审修复 H1）。
 *
 * 覆盖场景：
 * - 未登录 GET /today 返回 401
 * - 未登录 POST 返回 401
 * - 登录用户首次签到返回 200 + streak=1
 * - 同日重复签到返回 409
 * - GET /today 已签到返回 streak
 * - 并发签到两个都返回正确（评审 H2）
 */

import {
  apiGet,
  apiPost,
  isE2E,
  registerUser,
  waitForServer,
} from "./helper.ts";

const skip = !isE2E;
let userToken = "";
const ts = Date.now();
const TEST_USER = {
  username: `e2e_checkin_${ts}`,
  email: `e2e_checkin_${ts}@test.com`,
  password: "E2eCheckinPass1",
};

Deno.test({
  name: "[e2e/checkin] Setup",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    await waitForServer();
    userToken = await registerUser(
      TEST_USER.username,
      TEST_USER.email,
      TEST_USER.password,
    );
    console.log("  ✓ 测试用户已注册并登录");
  },
});

Deno.test({
  name: "[e2e/checkin] 1.1 未登录 POST 返回 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status } = await apiPost("/api/v1/checkin", {});
    if (status !== 401) throw new Error("期望 401, 实际 " + status);
    console.log("  ✓ 未登录 POST → 401");
  },
});

Deno.test({
  name: "[e2e/checkin] 1.2 未登录 GET /today 返回 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status } = await apiGet("/api/v1/checkin/today");
    if (status !== 401) throw new Error("期望 401, 实际 " + status);
    console.log("  ✓ 未登录 GET /today → 401");
  },
});

Deno.test({
  name: "[e2e/checkin] 1.3 已登录首次签到返回 200 + streak=1",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiPost("/api/v1/checkin", {}, userToken);
    if (status !== 200) {
      throw new Error("期望 200, 实际 " + status + " " + JSON.stringify(body));
    }
    const b = body as { data: { checked_in: boolean; streak: number } };
    if (b.data.checked_in !== true || b.data.streak !== 1) {
      throw new Error("期望 checked_in=true,streak=1, 实际 " + JSON.stringify(b));
    }
    console.log("  ✓ 首次签到 → 200 streak=1");
  },
});

Deno.test({
  name: "[e2e/checkin] 1.4 同日重复签到返回 409",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiPost("/api/v1/checkin", {}, userToken);
    if (status !== 409) {
      throw new Error("期望 409, 实际 " + status + " " + JSON.stringify(body));
    }
    const b = body as { code?: string };
    if (b.code !== "CONFLICT_ERROR") {
      throw new Error("期望 code=CONFLICT_ERROR, 实际 " + b.code);
    }
    console.log("  ✓ 重复签到 → 409 CONFLICT_ERROR");
  },
});

Deno.test({
  name: "[e2e/checkin] 1.5 GET /today 已签到返回 streak",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiGet("/api/v1/checkin/today", userToken);
    if (status !== 200) {
      throw new Error("期望 200, 实际 " + status);
    }
    const b = body as { data: { checked_in: boolean; streak: number } };
    if (b.data.checked_in !== true || b.data.streak < 1) {
      throw new Error("期望 checked_in=true 且 streak≥1, 实际 " + JSON.stringify(b));
    }
    console.log("  ✓ GET /today → streak=" + b.data.streak);
  },
});

Deno.test({
  name: "[e2e/checkin] 1.6 并发签到：仅一个 200，其余 409（评审 H2）",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    // 注册新用户避免 1.3 已签到污染
    const ts2 = Date.now() + 1;
    const token2 = await registerUser(
      `e2e_checkin_concurrent_${ts2}`,
      `e2e_checkin_concurrent_${ts2}@test.com`,
      "E2eCheckinPass1",
    );
    // 5 个并发请求：1 个 200，其余 4 个 409
    const results = await Promise.all(
      Array.from({ length: 5 }, () => apiPost("/api/v1/checkin", {}, token2)),
    );
    const successCount = results.filter((r) => r.status === 200).length;
    const conflictCount = results.filter((r) => r.status === 409).length;
    if (successCount !== 1 || conflictCount !== 4) {
      throw new Error(
        "期望 1×200 + 4×409, 实际 " +
          results.map((r) => r.status).join(","),
      );
    }
    console.log("  ✓ 并发签到 → 1×200 + 4×409 (无 500)");
  },
});