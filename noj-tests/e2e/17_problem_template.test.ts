/**
 * 题目初始代码模板 E2E 测试。
 *
 * 覆盖：
 * - GET /api/v1/problems/:id/template 按 manifest.template 读取 template.py 作为初始代码
 * - 404 当题目无模板文件
 * - 401 未登录
 */

import {
  apiGet,
  e2eTest,
  getAdminToken,
  isE2E,
  waitForServer,
} from "./helper.ts";

let adminToken = "";

e2eTest("[e2e/template] Setup", async () => {
  if (!isE2E) return;
  await waitForServer();
  adminToken = await getAdminToken();
});

e2eTest(
  "[e2e/template] 8.1 1001 按 manifest.template 读取 A+B template.py → 返回内容",
  async () => {
    if (!isE2E) return;
    const res = await apiGet("/api/v1/problems/P1001/template", adminToken);
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
      throw new Error("模板内容应包含 a + b（A+B starter code）");
    }
  },
);

e2eTest(
  "[e2e/template] 8.2 1002 按 manifest.template 读取 template.py → 返回内容",
  async () => {
    if (!isE2E) return;
    const res = await apiGet("/api/v1/problems/P1002/template", adminToken);
    if (res.status !== 200) {
      throw new Error(`期望 200，实际 ${res.status}`);
    }
    const body = res.body as { data?: { content?: string } };
    if (!body?.data?.content) {
      throw new Error("响应 data.content 应存在");
    }
  },
);

e2eTest("[e2e/template] 8.3 不存在的题目 → 404 或 400", async () => {
  if (!isE2E) return;
  const res = await apiGet("/api/v1/problems/99999/template", adminToken);
  if (res.status !== 404 && res.status !== 400) {
    throw new Error(`期望 404 或 400，实际 ${res.status}`);
  }
});

e2eTest("[e2e/template] 8.4 未登录 → 401", async () => {
  if (!isE2E) return;
  const res = await apiGet("/api/v1/problems/P1001/template");
  if (res.status !== 401) {
    throw new Error(`期望 401，实际 ${res.status}`);
  }
});
