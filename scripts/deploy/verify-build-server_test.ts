import {
  extractCompileIncludes,
  verifyBuildServerScript,
  verifyCompileIncludes,
} from "./verify-build-server.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("build-server 门禁：脚本与 task 缺一不可", () => {
  const problems = verifyBuildServerScript();
  assert(problems.length === 0, `应无问题，实际: ${problems.join("; ")}`);
});

Deno.test("build-server 门禁：提取 deno compile --include 路径", () => {
  const text = `deno compile \\
  --include src/a.ts \\
  --include   src/b.ts --output bin/x src/main.ts`;
  const got = extractCompileIncludes(text).join(",");
  assert(got === "src/a.ts,src/b.ts", `实际: ${got}`);
});

Deno.test("build-server 门禁：include 路径不存在时报错", () => {
  const problems = verifyCompileIncludes(
    "Dockerfile",
    "--include src/domains/catalog/services/oi-archive-worker.ts",
    () => false,
  );
  assert(problems.length === 1, `实际: ${problems.join("; ")}`);
  assert(
    problems[0].includes("src/domains/catalog/services/oi-archive-worker.ts"),
    problems[0],
  );
});
