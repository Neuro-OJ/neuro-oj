import { checkRunbooks } from "./check-runbooks.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("check-runbooks: 返回数组", async () => {
  const errors = await checkRunbooks(".");
  assert(Array.isArray(errors), "应返回数组");
});
