/**
 * 排名/榜单 E2E 测试。
 *
 * 覆盖 Phase 1 审计发现零覆盖的 rankings 端点：
 * - GET /api/v1/rankings
 * - GET /api/v1/rankings/me
 */

import {
  apiGet,
  isE2E,
  registerUser,
  waitForServer,
} from "./helper.ts";

const skip = !isE2E;

let userToken = "";

Deno.test({
  name: "[e2e/rankings] Setup",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    await waitForServer();
    const ts = Date.now().toString(36);
    userToken = await registerUser(
      `rank_user_${ts}`,
      `rank_user_${ts}@test.com`,
      "RankPass1234",
    );
  },
});

Deno.test({
  name: "[e2e/rankings] 1.1 GET /rankings 返回数组",
  ignore: skip,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiGet("/api/v1/rankings", userToken);
    if (status !== 200) throw new Error(`期望 200，实际 ${status}`);
    const data = body as { data?: Array<unknown> };
    if (!Array.isArray(data?.data)) {
      throw new Error("rankings data 应为数组");
    }
  },
});

Deno.test({
  name: "[e2e/rankings] 1.2 GET /rankings 支持分页",
  ignore: skip,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    if (!isE2E) return;
    const { body } = await apiGet(
      "/api/v1/rankings?limit=5&offset=0",
      userToken,
    );
    const data = body as { data?: Array<unknown> };
    if (!Array.isArray(data?.data)) {
      throw new Error("分页 rankings data 应为数组");
    }
    if (data.data.length > 5) {
      throw new Error("limit=5 应返回不超过 5 条");
    }
  },
});

Deno.test({
  name: "[e2e/rankings] 1.3 GET /rankings/me 返回当前用户信息",
  ignore: skip,
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiGet(
      "/api/v1/rankings/me",
      userToken,
    );
    if (status !== 200) {
      throw new Error(`GET /rankings/me 期望 200，实际 ${status}`);
    }
    const data = body as { data?: { rank?: number; score?: number } };
    if (data?.data === undefined) {
      throw new Error("/rankings/me 应返回用户排名信息");
    }
  },
});
