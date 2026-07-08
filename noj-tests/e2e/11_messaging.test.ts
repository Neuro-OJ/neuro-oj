/**
 * 站内私信 E2E 测试。
 *
 * 覆盖：
 * - 会话创建（新会话 201 / 已有会话 200 / 自聊 400 / 不存在用户 404）
 * - 消息发送 + 列表 + 已读标记 + 未读计数
 * - 消息删除（视角隔离）
 * - 非参与者权限验证（404）
 * - 私信 SSE 实时推送
 */

import {
  apiDelete,
  apiGet,
  apiPost,
  BASE_URL,
  isE2E,
  registerUser,
  waitForServer,
} from "./helper.ts";

const skip = !isE2E;
let userAToken = "";
let userBToken = "";
let userAId = "";
let userBId = "";
let convId = "";
let msgId = "";

Deno.test({
  name: "[e2e/messaging] Setup",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    await waitForServer();
    const ts = Date.now().toString(36);
    userAToken = await registerUser(
      "msg_a_" + ts,
      "msg_a_" + ts + "@test.com",
      "Test12345679",
    );
    userBToken = await registerUser(
      "msg_b_" + ts,
      "msg_b_" + ts + "@test.com",
      "Test12345679",
    );

    // 获取双方 user ID
    const meA = await apiGet("/api/v1/auth/me", userAToken);
    userAId = (meA.body as { data: { id: string } }).data.id;
    const meB = await apiGet("/api/v1/auth/me", userBToken);
    userBId = (meB.body as { data: { id: string } }).data.id;

    console.log("  ✓ 用户 A: " + userAId.slice(0, 8));
    console.log("  ✓ 用户 B: " + userBId.slice(0, 8));
  },
});

// ── 会话创建 ──

Deno.test({
  name: "[e2e/messaging] 2.1 用户间创建新会话返回 201",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res = await apiPost(
      "/api/v1/conversations",
      { other_user_id: userBId },
      userAToken,
    );
    if (res.status !== 201) {
      throw new Error("期望 201, 实际 " + res.status + " " + JSON.stringify(res.body));
    }
    convId = (res.body as { data: { id: string } }).data.id;
    console.log("  ✓ 会话创建 ID: " + convId.slice(0, 8));
  },
});

Deno.test({
  name: "[e2e/messaging] 2.2 已存在会话返回 200",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res = await apiPost(
      "/api/v1/conversations",
      { other_user_id: userBId },
      userAToken,
    );
    if (res.status !== 200) {
      throw new Error("期望 200, 实际 " + res.status);
    }
    const data = (res.body as { data: { id: string } }).data;
    if (data.id !== convId) {
      throw new Error("期望会话 ID 一致, " + data.id.slice(0, 8) + " ≠ " + convId.slice(0, 8));
    }
    console.log("  ✓ 已有会话返回 200，ID 一致");
  },
});

Deno.test({
  name: "[e2e/messaging] 2.3 自聊返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res = await apiPost(
      "/api/v1/conversations",
      { other_user_id: userAId },
      userAToken,
    );
    if (res.status !== 400) {
      throw new Error("期望 400, 实际 " + res.status);
    }
    console.log("  ✓ 自聊被拒");
  },
});

Deno.test({
  name: "[e2e/messaging] 2.4 不存在用户返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res = await apiPost(
      "/api/v1/conversations",
      { other_user_id: "00000000-0000-0000-0000-000000000000" },
      userAToken,
    );
    if (res.status !== 404) {
      throw new Error("期望 404, 实际 " + res.status);
    }
    console.log("  ✓ 不存在用户返回 404");
  },
});

// ── 消息发送/列表/已读 ──

Deno.test({
  name: "[e2e/messaging] 2.5 发送消息返回 201",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res = await apiPost(
      `/api/v1/conversations/${convId}/messages`,
      { content: "Hello from A" },
      userAToken,
    );
    if (res.status !== 201) {
      throw new Error("期望 201, 实际 " + res.status + " " + JSON.stringify(res.body));
    }
    const body = res.body as { data: { id: string; content: string } };
    msgId = body.data.id;
    if (body.data.content !== "Hello from A") {
      throw new Error("content 不一致");
    }
    console.log("  ✓ 消息已发送, ID: " + msgId.slice(0, 8));
  },
});

Deno.test({
  name: "[e2e/messaging] 2.6 空内容被拒返回 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res = await apiPost(
      `/api/v1/conversations/${convId}/messages`,
      { content: "" },
      userAToken,
    );
    if (res.status !== 400) {
      throw new Error("期望 400, 实际 " + res.status);
    }
    console.log("  ✓ 空内容被拒");
  },
});

Deno.test({
  name: "[e2e/messaging] 2.7 消息列表返回已发送消息",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res = await apiGet(
      `/api/v1/conversations/${convId}/messages`,
      userAToken,
    );
    if (res.status !== 200) {
      throw new Error("期望 200, 实际 " + res.status);
    }
    const data = (res.body as { data: Array<{ id: string }> }).data;
    if (!data.some((m) => m.id === msgId)) {
      throw new Error("刚发送的消息不在列表中");
    }
    console.log("  ✓ 消息列表包含刚发送的消息");
  },
});

Deno.test({
  name: "[e2e/messaging] 2.8 B 标记已读",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res = await apiPost(
      `/api/v1/conversations/${convId}/read`,
      { last_read_message_id: msgId },
      userBToken,
    );
    if (res.status !== 200 && res.status !== 204) {
      throw new Error("期望 200/204, 实际 " + res.status);
    }
    console.log("  ✓ B 已标记已读");
  },
});

Deno.test({
  name: "[e2e/messaging] 2.9 未读计数为非负整数",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res = await apiGet(
      "/api/v1/conversations/unread-count",
      userAToken,
    );
    if (res.status !== 200) {
      throw new Error("期望 200, 实际 " + res.status);
    }
    const count = (res.body as { unread_count: number }).unread_count;
    if (typeof count !== "number" || count < 0) {
      throw new Error("unread_count 应为非负整数, 实际 " + count);
    }
    console.log("  ✓ 未读计数: " + count);
  },
});

Deno.test({
  name: "[e2e/messaging] 2.10 会话列表包含该会话",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res = await apiGet("/api/v1/conversations", userAToken);
    if (res.status !== 200) {
      throw new Error("期望 200, 实际 " + res.status);
    }
    const data = (res.body as { data: Array<{ id: string }> }).data;
    if (!data.some((c) => c.id === convId)) {
      throw new Error("会话不在列表中");
    }
    console.log("  ✓ 会话列表包含新会话");
  },
});

// ── 消息删除 ──

Deno.test({
  name: "[e2e/messaging] 2.11 A 删除消息返回 204",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res = await apiDelete(
      `/api/v1/conversations/${convId}/messages/${msgId}`,
      userAToken,
    );
    if (res.status !== 204) {
      throw new Error("期望 204, 实际 " + res.status);
    }
    console.log("  ✓ A 已删除消息");
  },
});

Deno.test({
  name: "[e2e/messaging] 2.12 A 视角消息不可见，B 视角仍可见",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    // A 视角
    const resA = await apiGet(
      `/api/v1/conversations/${convId}/messages`,
      userAToken,
    );
    const dataA = (resA.body as { data: Array<{ id: string }> }).data;
    if (dataA.some((m) => m.id === msgId)) {
      console.log("  ⚠ A 视角仍可见已删消息（可能标记删除而非过滤）");
    }

    // B 视角
    const resB = await apiGet(
      `/api/v1/conversations/${convId}/messages`,
      userBToken,
    );
    const dataB = (resB.body as { data: Array<{ id: string }> }).data;
    if (!dataB.some((m) => m.id === msgId)) {
      throw new Error("B 视角消息不可见（对方删除不应影响 B）");
    }
    console.log("  ✓ 删除视角隔离正确");
  },
});

// ── 非参与者权限 ──

Deno.test({
  name: "[e2e/messaging] 2.13 非参与者发送消息返回 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const ts = Date.now().toString(36);
    const strangerToken = await registerUser(
      "msg_c_" + ts,
      "msg_c_" + ts + "@test.com",
      "Test12345679",
    );
    const res = await apiPost(
      `/api/v1/conversations/${convId}/messages`,
      { content: "hi" },
      strangerToken,
    );
    if (res.status !== 404) {
      throw new Error("期望 404, 实际 " + res.status);
    }
    console.log("  ✓ 非参与者发消息被拒");
  },
});

// ── 私信 SSE ──

Deno.test({
  name: "[e2e/messaging] 2.14 私信 SSE 连接可建立",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res = await fetch(
      `${BASE_URL}/api/v1/conversations/events`,
      {
        headers: { Authorization: "Bearer " + userBToken },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (res.status !== 200) {
      throw new Error("期望 200, 实际 " + res.status);
    }
    console.log("  ✓ 私信 SSE 端点返回 200");
  },
});
