import { SLOS } from "../slo.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("slo: 每个 SLO 都有 runbook 且 objective 合法", () => {
  for (const slo of SLOS) {
    assert(slo.objective > 0 && slo.objective < 1, "objective 应在 (0,1)");
    assert(
      slo.runbook.startsWith("deploy/monitoring/runbooks/"),
      "runbook 路径应指向 runbooks",
    );
  }
});
