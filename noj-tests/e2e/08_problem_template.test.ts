/**
 * 题目初始代码模板 E2E 测试。
 *
 * 覆盖：
 * - GET /api/v1/problems/:id/template 读取 submission.py 作为初始代码
 * - 404 当题目无 submission.py
 * - 401 未登录
 */

import { apiGet, getAdminToken, isE2E, waitForServer } from "./helper.ts";

const skip = !isE2E;
let adminToken = "";

Deno.test({
  name: "[e2e/template] Setup",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    await waitForServer();
    adminToken = await getAdminToken();
  },
});

Deno.test({
  name: "[e2e/template] 8.1 1003 有 submission.py → 返回内容",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res = await apiGet("/api/v1/problems/1003/template", adminToken);
    if (res.status !== 200) {
      throw new Error(`期望 200，实际 ${res.status}`);
    }
    const body = res.body as { data?: { content?: string; language?: string } };
    if (!body?.data?.content) {
      throw new Error("响应 data.content 应存在");
    }
    if (body.data.language !== "python3") {
      throw new Error(`期望 language=python3，实际 ${body.data.language}`);
    }
    if (!body.data.content.includes("a + b")) {
      throw new Error("模板内容应包含 a + b（A+B 参考解法）");
    }
  },
});

Deno.test({
  name: "[e2e/template] 8.2 1001 有 submission.py → 返回内容",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res = await apiGet("/api/v1/problems/1001/template", adminToken);
    if (res.status !== 200) {
      throw new Error(`期望 200，实际 ${res.status}`);
    }
    const body = res.body as { data?: { content?: string } };
    if (!body?.data?.content) {
      throw new Error("响应 data.content 应存在");
    }
  },
});

Deno.test({
  name: "[e2e/template] 8.3 1002 无 submission.py → 404",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res = await apiGet("/api/v1/problems/1002/template", adminToken);
    if (res.status !== 404) {
      throw new Error(`期望 404，实际 ${res.status}`);
    }
  },
});

Deno.test({
  name: "[e2e/template] 8.4 不存在的题目 → 404 或 400",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res = await apiGet("/api/v1/problems/99999/template", adminToken);
    if (res.status !== 404 && res.status !== 400) {
      throw new Error(`期望 404 或 400，实际 ${res.status}`);
    }
  },
});

Deno.test({
  name: "[e2e/template] 8.5 未登录 → 401",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res = await apiGet("/api/v1/problems/1003/template");
    if (res.status !== 401) {
      throw new Error(`期望 401，实际 ${res.status}`);
    }
  },
});
