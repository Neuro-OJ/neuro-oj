/**
 * 每日签到 E2E 测试（issue #? 评审修复 H1）。
 *
 * 覆盖场景：
 * - 未登录 GET /today 返回 401
 * - 未登录 POST 返回 401
 * - 无效 token 返回 401
 * - 登录用户首次签到返回 200 + streak=1
 * - 同日重复签到返回 409 + CONFLICT_ERROR
 * - GET /today 签到前返回 checked_in=false + streak=0
 * - GET /today 签到后返回 checked_in=true + streak
 * - 多用户隔离：各自 streak 独立
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
  name: "[e2e/checkin] 1.2b 无效 token POST 返回 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status } = await apiPost("/api/v1/checkin", {}, "invalidtoken123");
    if (status !== 401) throw new Error("期望 401, 实际 " + status);
    console.log("  ✓ 无效 token POST → 401");
  },
});

Deno.test({
  name: "[e2e/checkin] 1.2c 无效 token GET /today 返回 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status } = await apiGet("/api/v1/checkin/today", "invalidtoken123");
    if (status !== 401) throw new Error("期望 401, 实际 " + status);
    console.log("  ✓ 无效 token GET /today → 401");
  },
});

Deno.test({
  name: "[e2e/checkin] 1.2d 签到前 GET /today 返回 checked_in=false + streak=0",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const ts2 = Date.now() + 1;
    const freshToken = await registerUser(
      `e2e_cb_${ts2}`,
      `e2e_cb_${ts2}@test.com`,
      "E2eCheckinPass1",
    );
    const { status, body } = await apiGet("/api/v1/checkin/today", freshToken);
    if (status !== 200) throw new Error("期望 200, 实际 " + status);
    const b = body as { data: { checked_in: boolean; streak: number } };
    if (b.data.checked_in !== false || b.data.streak !== 0) {
      throw new Error(
        "期望 checked_in=false,streak=0, 实际 " + JSON.stringify(b),
      );
    }
    console.log("  ✓ 签到前 GET /today → checked_in=false, streak=0");
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
  name: "[e2e/checkin] 1.4 同日重复签到返回 409 + 完整错误体",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiPost("/api/v1/checkin", {}, userToken);
    if (status !== 409) {
      throw new Error("期望 409, 实际 " + status + " " + JSON.stringify(body));
    }
    const b = body as { code?: string; error?: string };
    if (b.code !== "CONFLICT_ERROR") {
      throw new Error("期望 code=CONFLICT_ERROR, 实际 " + b.code);
    }
    if (b.error !== "今天已签到") {
      throw new Error("期望 error='今天已签到', 实际 " + b.error);
    }
    console.log("  ✓ 重复签到 → 409 CONFLICT_ERROR \"今天已签到\"");
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
      `e2e_cc_${ts2}`,
      `e2e_cc_${ts2}@test.com`,
      "E2eCheckinPass1",
    );
    // 3 个并发请求：1 个 200，其余 2 个 409
    const TIMEOUT_MS = 10_000;
    const results = await Promise.race([
      Promise.all(
        Array.from({ length: 3 }, () => apiPost("/api/v1/checkin", {}, token2)),
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("并发签到测试超时")), TIMEOUT_MS)
      ),
    ]);
    const successCount = results.filter((r) => r.status === 200).length;
    const conflictCount = results.filter((r) => r.status === 409).length;
    if (successCount !== 1 || conflictCount !== 2) {
      throw new Error(
        "期望 1×200 + 2×409, 实际 " +
          results.map((r) => r.status).join(","),
      );
    }
    console.log("  ✓ 并发签到 → 1×200 + 2×409 (无 500)");
  },
});

Deno.test({
  name: "[e2e/checkin] 1.7 多用户隔离：各自签到独立",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const ts3 = Date.now() + 2;
    // 用户 A 签到，用户 B 首次签到应不受影响
    const tokenA = await registerUser(
      `e2e_ia_${ts3}`,
      `e2e_ia_${ts3}@test.com`,
      "E2eCheckinPass1",
    );
    const tokenB = await registerUser(
      `e2e_ib_${ts3}`,
      `e2e_ib_${ts3}@test.com`,
      "E2eCheckinPass1",
    );

    // 用户 A 签到 → streak=1
    const { status: sA, body: bA } = await apiPost(
      "/api/v1/checkin", {}, tokenA,
    );
    if (sA !== 200) throw new Error("A 签到失败: " + sA);
    const dA = bA as { data: { streak: number } };
    if (dA.data.streak !== 1) throw new Error("A 期望 streak=1, 实际 " + dA.data.streak);

    // 用户 B 首次签到也应返回 streak=1（不受 A 影响）
    const { status: sB, body: bB } = await apiPost(
      "/api/v1/checkin", {}, tokenB,
    );
    if (sB !== 200) throw new Error("B 签到失败: " + sB);
    const dB = bB as { data: { streak: number } };
    if (dB.data.streak !== 1) throw new Error("B 期望 streak=1, 实际 " + dB.data.streak);

    // 用户 A 重复签到 → 409（隔离性：不影响 B）
    const { status: sA2 } = await apiPost("/api/v1/checkin", {}, tokenA);
    if (sA2 !== 409) throw new Error("A 重复签到期望 409, 实际 " + sA2);

    // 用户 B 今日签到状态：checked_in=true, streak=1
    const { status: sB2, body: bB2 } = await apiGet(
      "/api/v1/checkin/today", tokenB,
    );
    if (sB2 !== 200) throw new Error("B 查询期望 200, 实际 " + sB2);
    const dB2 = bB2 as { data: { checked_in: boolean; streak: number } };
    if (dB2.data.checked_in !== true || dB2.data.streak !== 1) {
      throw new Error(
        "B 期望 checked_in=true,streak=1, 实际 " + JSON.stringify(dB2),
      );
    }

    console.log("  ✓ 多用户隔离 → 各自签到独立，互不影响");
  },
});