import { verifySetupThin } from "./verify-setup-thin.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("setup.sh 薄引导门禁：仅下载/校验 noj-cli", () => {
  const problems = verifySetupThin();
  assert(problems.length === 0, `应无问题，实际: ${problems.join("; ")}`);
});
