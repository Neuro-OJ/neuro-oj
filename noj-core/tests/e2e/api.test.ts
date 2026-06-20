/**
 * E2E 测试：题目管理 + 分类 + 管理员鉴权。
 *
 * 依赖外部运行的 noj-core 服务器，全通过 HTTP API 测试。
 *
 * 启动方式：
 *   1. 启动服务器（含迁移 + seed + ADMIN_EMAIL 预设）
 *   2. NOJ_RUN_E2E=1 deno test -A tests/e2e/api.test.ts
 *
 * 环境变量见 helper.ts。
 */

import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import {
  ADMIN_EMAIL,
  ADMIN_PASS,
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
  isE2E,
  loginUser,
  registerUser,
  waitForServer,
} from "./helper.ts";

const skip = !isE2E;

// ——— 全局测试状态 ———
let adminToken = "";
let regularToken = "";
let regularUserId = "";

// ——— 设置 ———

Deno.test({
  name: "[e2e] 0.1 等待服务器就绪",
  ignore: skip,
  fn: async () => {
    await waitForServer();
  },
});

Deno.test({
  name: "[e2e] 0.2 获取管理员 token",
  ignore: skip,
  fn: async () => {
    adminToken = await loginUser(ADMIN_EMAIL, ADMIN_PASS);
    assertExists(adminToken);
  },
});

Deno.test({
  name: "[e2e] 0.3 注册普通用户",
  ignore: skip,
  fn: async () => {
    const ts = Date.now().toString(36);
    regularToken = await registerUser(
      `e2e_user_${ts}`,
      `e2e_user_${ts}@test.com`,
      "e2e_user_pass",
    );
    assertExists(regularToken);

    // 拿用户 ID 供后续 promote 测试用
    const res = await apiGet("/api/v1/auth/me", regularToken);
    assertEquals(res.status, 200);
    regularUserId = (res.body as { data: { id: string } }).data.id;
  },
});

// ——— 分类管理 ———

Deno.test({
  name: "[e2e/categories] 1.1 GET 分类树",
  ignore: skip,
  fn: async () => {
    const { status, body } = await apiGet("/api/v1/categories");
    assertEquals(status, 200);
    const d = body as { data: unknown[] };
    assertEquals(Array.isArray(d.data), true);
  },
});

Deno.test({
  name: "[e2e/categories] 1.2 管理员创建顶级分类",
  ignore: skip,
  fn: async () => {
    const slug = `e2e-cat-${Date.now().toString(36)}`;
    const { status, body } = await apiPost(
      "/api/v1/categories",
      { name: "E2E 分类", slug, description: "E2E 测试" },
      adminToken,
    );
    assertEquals(status, 201);
    assertEquals((body as { data: { level: number } }).data.level, 0);
  },
});

Deno.test({
  name: "[e2e/categories] 1.3 管理员创建子分类自动计算 level",
  ignore: skip,
  fn: async () => {
    const parentSlug = `e2e-parent-${Date.now().toString(36)}`;
    const parentRes = await apiPost(
      "/api/v1/categories",
      { name: "E2E 父", slug: parentSlug },
      adminToken,
    );
    const parentId = (parentRes.body as { data: { id: string } }).data.id;

    const childSlug = `e2e-child-${Date.now().toString(36)}`;
    const { body } = await apiPost(
      "/api/v1/categories",
      { name: "E2E 子", slug: childSlug, parent_id: parentId },
      adminToken,
    );
    const d = body as { data: { level: number; parent_id: string } };
    assertEquals(d.data.level, 1);
    assertEquals(d.data.parent_id, parentId);
  },
});

Deno.test({
  name: "[e2e/categories] 1.4 普通用户创建分类被拒",
  ignore: skip,
  fn: async () => {
    const { status } = await apiPost(
      "/api/v1/categories",
      { name: "Hack", slug: "hack" },
      regularToken,
    );
    assertEquals(status, 403);
  },
});

Deno.test({
  name: "[e2e/categories] 1.5 重复 slug 冲突",
  ignore: skip,
  fn: async () => {
    const slug = `e2e-dup-${Date.now().toString(36)}`;
    await apiPost(
      "/api/v1/categories",
      { name: "原始", slug },
      adminToken,
    );
    const { status } = await apiPost(
      "/api/v1/categories",
      { name: "重复", slug },
      adminToken,
    );
    assertEquals(status, 409);
  },
});

Deno.test({
  name: "[e2e/categories] 1.6 删除带子分类的分类被拒",
  ignore: skip,
  fn: async () => {
    const slug = `e2e-del-parent-${Date.now().toString(36)}`;
    const parentRes = await apiPost(
      "/api/v1/categories",
      { name: "要删的父", slug },
      adminToken,
    );
    const parentId = (parentRes.body as { data: { id: string } }).data.id;
    // 加个子分类
    await apiPost(
      "/api/v1/categories",
      { name: "子", slug: `${slug}-child`, parent_id: parentId },
      adminToken,
    );
    const { status } = await apiDelete(
      `/api/v1/categories/${parentId}`,
      adminToken,
    );
    assertEquals(status, 400);
  },
});

// ——— 题目管理 ———

let createdProblemId = "";

Deno.test({
  name: "[e2e/problems] 2.1 公共列表",
  ignore: skip,
  fn: async () => {
    const { status, body } = await apiGet("/api/v1/problems");
    assertEquals(status, 200);
    const d = body as { data: unknown[]; total: number };
    assertEquals(Array.isArray(d.data), true);
    assertEquals(typeof d.total, "number");
  },
});

Deno.test({
  name: "[e2e/problems] 2.2 管理员创建题目",
  ignore: skip,
  fn: async () => {
    const { status, body } = await apiPost(
      "/api/v1/problems",
      {
        title: "E2E 两数之和",
        description: "实现两数之和。",
        difficulty: "easy",
        judge_image: "noj-judge-python",
        judge_command: "python3 /tmp/evaluate.py",
        time_limit_ms: 3000,
        memory_limit_mb: 256,
      },
      adminToken,
    );
    assertEquals(status, 201);
    const d = body as { data: { id: string } };
    createdProblemId = d.data.id;
    assertExists(createdProblemId);
  },
});

Deno.test({
  name: "[e2e/problems] 2.3 普通用户创建被拒",
  ignore: skip,
  fn: async () => {
    const { status } = await apiPost(
      "/api/v1/problems",
      {
        title: "Hack",
        description: "x",
        judge_image: "img",
        judge_command: "cmd",
      },
      regularToken,
    );
    assertEquals(status, 403);
  },
});

Deno.test({
  name: "[e2e/problems] 2.4 管理员更新题目",
  ignore: skip,
  fn: async () => {
    const { status, body } = await apiPut(
      `/api/v1/problems/${createdProblemId}`,
      { title: "E2E 两数之和 v2", difficulty: "hard" },
      adminToken,
    );
    assertEquals(status, 200);
    const d = body as { data: { title: string; difficulty: string } };
    assertEquals(d.data.title, "E2E 两数之和 v2");
    assertEquals(d.data.difficulty, "hard");
  },
});

Deno.test({
  name: "[e2e/problems] 2.5 按难度筛选",
  ignore: skip,
  fn: async () => {
    const { status, body } = await apiGet("/api/v1/problems?difficulty=hard");
    assertEquals(status, 200);
    const d = body as { data: { difficulty: string }[] };
    assertEquals(d.data.every((p) => p.difficulty === "hard"), true);
  },
});

Deno.test({
  name: "[e2e/problems] 2.6 按关键词搜索",
  ignore: skip,
  fn: async () => {
    const { status, body } = await apiGet("/api/v1/problems?keyword=两数之和");
    assertEquals(status, 200);
    const d = body as { total: number };
    assertEquals(d.total >= 1, true);
  },
});

Deno.test({
  name: "[e2e/problems] 2.7 非法难度值",
  ignore: skip,
  fn: async () => {
    const { status } = await apiGet("/api/v1/problems?difficulty=invalid");
    assertEquals(status, 400);
  },
});

Deno.test({
  name: "[e2e/problems] 2.8 管理员删除题目",
  ignore: skip,
  fn: async () => {
    const { status } = await apiDelete(
      `/api/v1/problems/${createdProblemId}`,
      adminToken,
    );
    assertEquals(status, 204);

    const getRes = await apiGet(`/api/v1/problems/${createdProblemId}`);
    assertEquals(getRes.status, 404);
  },
});

// ——— 管理员提升 ———

Deno.test({
  name: "[e2e/auth] 3.1 非管理员调用 promote 被拒",
  ignore: skip,
  fn: async () => {
    const { status } = await apiPatch(`/api/v1/admin/users/some-id/role`, {
      role: "admin",
    }, regularToken);
    assertEquals(status, 403);
  },
});

Deno.test({
  name: "[e2e/auth] 3.2 缺少 role 字段",
  ignore: skip,
  fn: async () => {
    const { status } = await apiPatch(
      `/api/v1/admin/users/some-id/role`,
      {},
      adminToken,
    );
    assertEquals(status, 400);
  },
});

Deno.test({
  name: "[e2e/auth] 3.3 非法角色值",
  ignore: skip,
  fn: async () => {
    const { status } = await apiPatch(`/api/v1/admin/users/some-id/role`, {
      role: "superuser",
    }, adminToken);
    assertEquals(status, 400);
  },
});

Deno.test({
  name: "[e2e/auth] 3.4 提升不存在的用户",
  ignore: skip,
  fn: async () => {
    const { status } = await apiPatch(
      `/api/v1/admin/users/nonexistent-id/role`,
      { role: "admin" },
      adminToken,
    );
    assertEquals(status, 404);
  },
});

Deno.test({
  name: "[e2e/auth] 3.5 管理员提升用户成功",
  ignore: skip,
  fn: async () => {
    const { status, body } = await apiPatch(
      `/api/v1/admin/users/${regularUserId}/role`,
      { role: "admin" },
      adminToken,
    );
    assertEquals(status, 200);
    const d = body as { data: { role: string } };
    assertEquals(d.data.role, "admin");
  },
});

// ——— 提交列表 ———

Deno.test({
  name: "[e2e/submissions] 4.1 用户提交列表无 token 返回 401",
  ignore: skip,
  fn: async () => {
    const { status } = await apiGet("/api/v1/submissions");
    assertEquals(status, 401);
  },
});

Deno.test({
  name: "[e2e/submissions] 4.2 用户提交列表返回空列表和分页信息",
  ignore: skip,
  fn: async () => {
    const { status, body } = await apiGet(
      "/api/v1/submissions",
      regularToken,
    );
    assertEquals(status, 200);
    const d = body as { data: unknown[]; pagination: { page: number; per_page: number; total: number; total_pages: number } };
    assertEquals(Array.isArray(d.data), true);
    assertEquals(d.data.length, 0);
    assertEquals(d.pagination.page, 1);
    assertEquals(d.pagination.per_page, 20);
    assertEquals(d.pagination.total, 0);
    assertEquals(d.pagination.total_pages, 0);
  },
});

Deno.test({
  name: "[e2e/submissions] 4.3 用户提交列表按 status 非法值返回 400",
  ignore: skip,
  fn: async () => {
    const { status } = await apiGet(
      "/api/v1/submissions?status=invalid",
      regularToken,
    );
    assertEquals(status, 400);
  },
});

Deno.test({
  name: "[e2e/submissions] 4.4 管理员提交列表无 token 返回 401",
  ignore: skip,
  fn: async () => {
    const { status } = await apiGet("/api/v1/admin/submissions");
    assertEquals(status, 401);
  },
});

Deno.test({
  name: "[e2e/submissions] 4.5 普通用户访问管理员提交列表返回 403",
  ignore: skip,
  fn: async () => {
    const { status, body } = await apiGet(
      "/api/v1/admin/submissions",
      regularToken,
    );
    assertEquals(status, 403);
    const d = body as { error: string };
    assertEquals(d.error, "需要管理员权限");
  },
});

Deno.test({
  name: "[e2e/submissions] 4.6 管理员查看所有提交返回空列表",
  ignore: skip,
  fn: async () => {
    const { status, body } = await apiGet(
      "/api/v1/admin/submissions",
      adminToken,
    );
    assertEquals(status, 200);
    const d = body as { data: unknown[]; pagination: { total: number } };
    assertEquals(Array.isArray(d.data), true);
    assertEquals(typeof d.pagination.total, "number");
  },
});

Deno.test({
  name: "[e2e/submissions] 4.7 管理员按 user_id 筛选",
  ignore: skip,
  fn: async () => {
    const { status, body } = await apiGet(
      "/api/v1/admin/submissions?user_id=nonexistent-user",
      adminToken,
    );
    assertEquals(status, 200);
    const d = body as { data: unknown[]; pagination: { total: number } };
    assertEquals(d.data.length, 0);
    assertEquals(d.pagination.total, 0);
  },
});

Deno.test({
  name: "[e2e/submissions] 4.8 管理员按 problem_id 筛选",
  ignore: skip,
  fn: async () => {
    const { status, body } = await apiGet(
      "/api/v1/admin/submissions?problem_id=nonexistent",
      adminToken,
    );
    assertEquals(status, 200);
    const d = body as { data: unknown[]; pagination: { total: number } };
    assertEquals(d.data.length, 0);
    assertEquals(d.pagination.total, 0);
  },
});

// ——— 用户主页 ———

Deno.test({
  name: "[e2e/profile] 5.1 查看存在的用户主页",
  ignore: skip,
  fn: async () => {
    const { status, body } = await apiGet(
      `/api/v1/users/${regularUserId}/profile`,
    );
    assertEquals(status, 200);
    const d = body as {
      data: {
        user: { id: string; username: string };
        stats: { total_submissions: number; accepted: number; acceptance_rate: number; solved_count: number };
        solved_problems: unknown[];
        recent_submissions: unknown[];
      };
    };
    assertEquals(d.data.user.id, regularUserId);
    assertEquals(typeof d.data.user.username, "string");
    assertEquals(typeof d.data.stats.total_submissions, "number");
    assertEquals(typeof d.data.stats.accepted, "number");
    assertEquals(typeof d.data.stats.acceptance_rate, "number");
    assertEquals(typeof d.data.stats.solved_count, "number");
    assertEquals(Array.isArray(d.data.solved_problems), true);
    assertEquals(Array.isArray(d.data.recent_submissions), true);
  },
});

Deno.test({
  name: "[e2e/profile] 5.2 查看不存在的用户返回 404",
  ignore: skip,
  fn: async () => {
    const { status, body } = await apiGet(
      "/api/v1/users/nonexistent-user-id/profile",
    );
    assertEquals(status, 404);
    const d = body as { error: string };
    assertEquals(d.error, "用户不存在");
  },
});

Deno.test({
  name: "[e2e/profile] 5.3 用户主页无需认证即可访问",
  ignore: skip,
  fn: async () => {
    // 不传 token 访问，应返回 200 或 404（取决于用户是否存在），而非 401
    const { status } = await apiGet(
      `/api/v1/users/${regularUserId}/profile`,
    );
    assertEquals(status, 200);
  },
});
