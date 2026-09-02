import { verifyComposeServer } from "./verify-compose-server.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("Compose 兼容门禁：有 core 服务并使用 noj-server 镜像", () => {
  const problems = verifyComposeServer();
  assert(problems.length === 0, `应无问题，实际: ${problems.join("; ")}`);
});
