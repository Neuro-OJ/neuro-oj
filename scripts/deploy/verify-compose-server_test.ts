import { verifyComposeServer } from "./verify-compose-server.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("Compose 改名门禁：无 noj-core && 有 server", () => {
  const problems = verifyComposeServer();
  assert(problems.length === 0, `应无问题，实际: ${problems.join("; ")}`);
});
