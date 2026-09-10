import { createObservabilityRegistry } from "../../../src/shared/observability/registry.ts";
import { registerDbHealthProbe } from "../../../src/shared/db/connection.ts";
import { registerRedisHealthProbe } from "../../../src/shared/mq/connection.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("health registration: db/redis 探针注册后可列出", () => {
  const r = createObservabilityRegistry();
  registerDbHealthProbe(r);
  registerRedisHealthProbe(r);
  const names = r.listHealthProbes().map((p) => p.name);
  assert(names.includes("database"), "应包含 database 探针");
  assert(names.includes("redis"), "应包含 redis 探针");
});
