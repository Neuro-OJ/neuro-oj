import { verifyBuildServerScript } from "./verify-build-server.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("build-server 门禁：脚本与 task 缺一不可", () => {
  const problems = verifyBuildServerScript();
  assert(problems.length === 0, `应无问题，实际: ${problems.join("; ")}`);
});
