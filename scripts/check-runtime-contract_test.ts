import { checkRuntimeContract } from "./check-runtime-contract.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("check-runtime-contract: 返回数组", async () => {
  const errors = await checkRuntimeContract(".");
  assert(Array.isArray(errors), "应返回数组");
});
