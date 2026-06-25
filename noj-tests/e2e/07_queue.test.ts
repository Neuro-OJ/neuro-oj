/**
 * 评测队列可见性 E2E 测试。
 */

import {
  apiGet,
  CODE_SAMPLES,
  isE2E,
  registerUser,
  submitCode,
  waitForServer,
} from "./helper.ts";

const skip = !isE2E;
let token = "";
const PROBLEM_ID = "1001";

Deno.test({
  name: "[e2e/queue] Setup",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    await waitForServer();
    const ts = Date.now().toString(36);
    token = await registerUser(
      "q_user_" + ts,
      "q_user_" + ts + "@test.com",
      "Pass1234Test",
    );
  },
});

Deno.test({
  name: "[e2e/queue] 6.1 公共队列概览结构",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status, body } = await apiGet("/api/v1/queue");
    if (status !== 200) throw new Error("期望 200");
    const d = body as {
      pending: unknown[];
      judging: unknown[];
      recently_completed: unknown[];
      stats: {
        pending_count: number;
        judging_count: number;
        completed_today: number;
      };
    };
    if (!Array.isArray(d.pending)) throw new Error("pending 应数组");
    if (!Array.isArray(d.judging)) throw new Error("judging 应数组");
    if (!Array.isArray(d.recently_completed)) {
      throw new Error("recently_completed 应数组");
    }
    if (typeof d.stats.pending_count !== "number") {
      throw new Error("pending_count 应数值");
    }
    if (typeof d.stats.judging_count !== "number") {
      throw new Error("judging_count 应数值");
    }
    if (typeof d.stats.completed_today !== "number") {
      throw new Error("completed_today 应数值");
    }
  },
});

Deno.test({
  name: "[e2e/queue] 6.2 提交后出现在队列中",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const id = await submitCode(token, PROBLEM_ID, CODE_SAMPLES.accepted);
    const { body } = await apiGet("/api/v1/queue");
    const q = body as { pending: { id: string }[]; judging: { id: string }[] };
    const ids = [...q.pending.map((x) => x.id), ...q.judging.map((x) => x.id)];
    if (!ids.includes(id)) throw new Error("提交未出现在队列");
  },
});

Deno.test({
  name: "[e2e/queue] 6.3 状态端点正确",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const id = await submitCode(token, PROBLEM_ID, CODE_SAMPLES.accepted);
    const { status, body } = await apiGet(
      "/api/v1/submissions/" + id + "/status",
      token,
    );
    if (status !== 200) throw new Error("期望 200");
    const d = body as {
      id: string;
      status: string;
      queue_position: number | null;
      queue_length: number | null;
      judge_started_at: string | null;
    };
    if (d.id !== id) throw new Error("ID 不匹配");
    if (!["pending", "judging", "finished", "error"].includes(d.status)) {
      throw new Error("无效状态");
    }
  },
});

Deno.test({
  name: "[e2e/queue] 6.4 未认证 401",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status } = await apiGet("/api/v1/submissions/dummy/status");
    if (status !== 401) throw new Error("期望 401");
  },
});

Deno.test({
  name: "[e2e/queue] 6.5 不存在 404",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const { status } = await apiGet(
      "/api/v1/submissions/nonexistent/status",
      token,
    );
    if (status !== 404) throw new Error("期望 404");
  },
});
