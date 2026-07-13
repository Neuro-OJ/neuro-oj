/**
 * 编辑器路由 E2E 测试
 *
 * 覆盖：
 * - 题目详情页含「开始编码」链接指向 /editor/:id
 * - /editor/:id SSR 路由可达
 * - 详情页 SSR 不再含 monaco-editor 字样
 * - /editor/:id SSR 不含 monaco-editor 字样（仅 ClientOnly fallback）
 * - editor 路由多次访问不影响服务端
 */

import { BASE_URL, isE2E } from "./helper.ts";

const skip = !isE2E;

Deno.test({
  name: "问题详情页含「开始编码」链接",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res = await fetch(`${BASE_URL}/problems/1001`);
    const html = await res.text();
    if (!html.includes("/editor/1001")) {
      throw new Error("题目详情页应包含指向 /editor/1001 的链接");
    }
  },
});

Deno.test({
  name: "问题详情页不再包含 monaco-editor 字样",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res = await fetch(`${BASE_URL}/problems/1001`);
    const html = await res.text();
    if (html.includes("monaco-editor")) {
      throw new Error("题目详情页不应再加载 Monaco Editor");
    }
  },
});

Deno.test({
  name: "/editor/:id SSR 路由可达",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res = await fetch(`${BASE_URL}/editor/1001`);
    const html = await res.text();
    if (!html || html.length < 100) {
      throw new Error("/editor/1001 应返回有效 HTML");
    }
  },
});

Deno.test({
  name: "/editor/:id SSR 不含 Monaco JS 脚本",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res = await fetch(`${BASE_URL}/editor/1001`);
    const html = await res.text();
    if (html.includes("monaco-editor")) {
      throw new Error("SSR 输出不应包含 monaco-editor（应仅客户端加载）");
    }
  },
});

Deno.test({
  name: "editor 路由多次访问不影响服务端",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const res1 = await fetch(`${BASE_URL}/editor/1001`);
    const html1 = await res1.text();
    const res2 = await fetch(`${BASE_URL}/editor/1001`);
    const html2 = await res2.text();
    if (html1.length !== html2.length) {
      throw new Error("相同 URL 多次访问应返回一致 SSR 输出");
    }
  },
});
