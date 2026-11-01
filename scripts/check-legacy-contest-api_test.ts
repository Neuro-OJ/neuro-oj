import { assertEquals } from "jsr:@std/assert@^1";
import {
  DELETED_ROUTE_FILES,
  findLegacyCallers,
  LEGACY_CONTEST_PREFIX,
  stripComments,
} from "./check-legacy-contest-api.ts";

Deno.test("常量：无域比赛前缀与已删除路由文件清单", () => {
  assertEquals(LEGACY_CONTEST_PREFIX, "/api/v1/contests");
  assertEquals(
    DELETED_ROUTE_FILES.includes(
      "noj-core/src/modules/contests/routes/contests.ts",
    ),
    true,
  );
});

Deno.test("注释剥离：文档里提到旧路径不算引用，行号保持不变", () => {
  const source = [
    "// 旧入口 /api/v1/contests/:id 已删除",
    "/*",
    " * 也不要写 /api/v1/contests",
    " */",
    "const url = '/api/v1/domains/main/contests/x';",
  ].join("\n");
  const stripped = stripComments(source).split("\n");
  assertEquals(stripped.length, 5, "剥离后行数必须与原文一致");
  assertEquals(stripped[0]!.includes(LEGACY_CONTEST_PREFIX), false);
  assertEquals(stripped[2]!.includes(LEGACY_CONTEST_PREFIX), false);

  const callers = findLegacyCallers([{ file: "noj-ui/x.ts", text: source }]);
  assertEquals(callers.length, 0);
});

Deno.test("引用扫描：真实调用被抓到，域路径不算", () => {
  const callers = findLegacyCallers([
    {
      file: "noj-ui/a.vue",
      text: "// /api/v1/contests/x\nconst p = '/api/v1/contests/x'",
    },
    { file: "noj-ui/b.ts", text: "const p = '/api/v1/domains/main/contests'" },
  ]);
  assertEquals(callers.map((c) => c.file), ["noj-ui/a.vue"]);
  assertEquals(callers[0]!.line, 2);
  assertEquals(callers[0]!.snippet.includes(LEGACY_CONTEST_PREFIX), true);
});
