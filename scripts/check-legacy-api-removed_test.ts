import { assertEquals } from "jsr:@std/assert@^1";
import {
  findWriteUsages,
  isWriteUsage,
  REMOVED_FLAGS,
  REMOVED_MECHANISM_FILES,
  REMOVED_WRITE_PREFIXES,
  stripComments,
} from "./check-legacy-api-removed.ts";

Deno.test("常量：无域写前缀与机制文件清单", () => {
  assertEquals(REMOVED_WRITE_PREFIXES.includes("/api/v1/problems"), true);
  assertEquals(
    REMOVED_MECHANISM_FILES.includes(
      "noj-core/src/modules/http/retired-endpoints.json",
    ),
    true,
  );
  assertEquals(REMOVED_FLAGS.includes("retireLegacyEndpoints"), true);
});

Deno.test("写用法判定：GET 读端点不算，写方法算", () => {
  assertEquals(
    isWriteUsage(
      "const res = await apiGet(`/api/v1/problems/1`);",
      "/api/v1/problems",
    ),
    false,
  );
  assertEquals(
    isWriteUsage(
      "await api.post('/api/v1/problems', body);",
      "/api/v1/problems",
    ),
    true,
  );
  assertEquals(
    isWriteUsage(
      "apiPost(`/api/v1/trainings`, body, token);",
      "/api/v1/trainings",
    ),
    true,
  );
});

Deno.test("注释剥离：文档里提到旧路径不算写用法", () => {
  const source = [
    "// 旧写入口 /api/v1/problems 已删除",
    "/*",
    " * POST /api/v1/problems",
    " */",
    "const url = '/api/v1/domains/main/problems';",
  ].join("\n");
  const stripped = stripComments(source).split("\n");
  assertEquals(stripped.length, 5);
  const offenses = findWriteUsages([{ file: "noj-ui/x.ts", text: source }]);
  assertEquals(offenses.length, 0);
});

Deno.test("扫描：真实写调用被抓到并给出行号", () => {
  const offenses = findWriteUsages([
    {
      file: "noj-ui/a.vue",
      text: "const a = 1;\nawait api.post(`/api/v1/submissions`, body);",
    },
    { file: "noj-ui/b.ts", text: "await apiGet(`/api/v1/problems/1`);" },
  ]);
  assertEquals(offenses.map((o) => o.file), ["noj-ui/a.vue"]);
  assertEquals(offenses[0]!.line, 2);
});

Deno.test("扫描：相对 URL + 跨行方法同样被抓到（审计 F3 漏检）", () => {
  // 演练的真实写法：基址在别处，路径是相对的，方法在相邻行。
  const offenses = findWriteUsages([
    {
      file: "noj-cli/src/prod/drill/verify.ts",
      text: [
        "const res = await this.api(",
        '  "POST",',
        '  "/problems/import-bundle",',
        "  { body: form },",
        ");",
      ].join("\n"),
    },
    {
      // 相对路径的读端点仍然允许（GET /problems/:id 还在）
      file: "noj-cli/src/problem/read.ts",
      text: 'const res = await api("GET", "/problems/1001");',
    },
  ]);
  assertEquals(offenses.map((o) => o.file), [
    "noj-cli/src/prod/drill/verify.ts",
  ]);
  assertEquals(offenses[0]!.line, 3);
});
