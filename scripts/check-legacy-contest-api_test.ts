import { assertEquals } from "jsr:@std/assert@^1";
import {
  CALLER_ALLOWLIST,
  classifyRoutes,
  extractDeclaredRoutes,
  findLegacyCallers,
  isWriteMethod,
  LEGACY_CONTEST_PREFIX,
  normalizeLegacyPath,
  stripComments,
} from "./check-legacy-contest-api.ts";

Deno.test("旧无域路径归一化：相对路径补前缀，完整路径不重复拼接", () => {
  assertEquals(normalizeLegacyPath("/"), LEGACY_CONTEST_PREFIX);
  assertEquals(normalizeLegacyPath("/:id/register"), "/api/v1/contests/:id/register");
  assertEquals(normalizeLegacyPath(":id/submit"), "/api/v1/contests/:id/submit");
  // retired-endpoints.json 存的是完整路径：再加一次前缀会让比对恒不相等
  assertEquals(
    normalizeLegacyPath("/api/v1/contests/:id/register"),
    "/api/v1/contests/:id/register",
  );
});

Deno.test("路由声明解析：跨行声明与多种方法都要被抓到", () => {
  const source = `
    contests.get("/", handler);
    contests.post("/:id/register", authMiddleware, handler);
    contests.post(
      "/:id/clarifications/:clarId/reply",
      authMiddleware,
      handler,
    );
    contests.delete(\`/:id\`, handler);
  `;
  const routes = extractDeclaredRoutes(source);
  assertEquals(routes, [
    { method: "GET", path: "/" },
    { method: "POST", path: "/:id/register" },
    { method: "POST", path: "/:id/clarifications/:clarId/reply" },
    { method: "DELETE", path: "/:id" },
  ]);
});

Deno.test("写方法判定：GET/HEAD 走只读兼容，其余必须退役", () => {
  assertEquals(isWriteMethod("GET"), false);
  assertEquals(isWriteMethod("head"), false);
  assertEquals(isWriteMethod("post"), true);
  assertEquals(isWriteMethod("PATCH"), true);
  assertEquals(isWriteMethod("DELETE"), true);
});

Deno.test("路由分类：未退役的写方法必须暴露成错误来源", () => {
  const declared = [
    { method: "GET", path: "/:id/ranking" },
    { method: "POST", path: "/:id/register" },
    { method: "POST", path: "/:id/submit" },
  ];
  const retired = [{ method: "POST", path: "/api/v1/contests/:id/register" }];
  const inventory = classifyRoutes(declared, retired);
  assertEquals(inventory.reads, [{ method: "GET", path: "/:id/ranking" }]);
  assertEquals(inventory.writesRetired, [{ method: "POST", path: "/:id/register" }]);
  assertEquals(inventory.writesNotRetired, [{ method: "POST", path: "/:id/submit" }]);
});

Deno.test("注释剥离：文档里提到旧路径不算调用方，行号保持不变", () => {
  const source = [
    "// 旧入口 /api/v1/contests/:id 只保留兼容",
    "/*",
    " * 也不要写 /api/v1/contests",
    " */",
    "const url = '/api/v1/contests/x/ranking';",
  ].join("\n");
  const stripped = stripComments(source).split("\n");
  assertEquals(stripped.length, 5, "剥离后行数必须与原文一致");
  assertEquals(stripped[0]!.includes(LEGACY_CONTEST_PREFIX), false);
  assertEquals(stripped[2]!.includes(LEGACY_CONTEST_PREFIX), false);

  const callers = findLegacyCallers([{ file: "noj-ui/x.ts", text: source }]);
  assertEquals(callers.length, 1);
  assertEquals(callers[0]!.line, 5);
});

Deno.test("调用方扫描：注释与真实调用分开统计", () => {
  const callers = findLegacyCallers([
    { file: "noj-ui/a.vue", text: "// /api/v1/contests/x\nconst p = '/api/v1/contests/x'" },
    { file: "noj-ui/b.ts", text: "const p = '/api/v1/domains/main/contests'" },
  ]);
  assertEquals(callers.map((c) => c.file), ["noj-ui/a.vue"]);
});

Deno.test("白名单条目都必须写明留用理由（防止空理由被顺手加进来）", () => {
  for (const [file, reason] of Object.entries(CALLER_ALLOWLIST)) {
    assertEquals(reason.trim().length > 10, true, `${file} 缺少留用理由`);
  }
});
