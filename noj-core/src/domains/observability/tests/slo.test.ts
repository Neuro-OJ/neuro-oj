import { SLOS } from "../slo.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("slo: ratio objective 合法，threshold objective 为正数", () => {
  for (const slo of SLOS) {
    if (slo.kind === "ratio") {
      assert(
        slo.objective > 0 && slo.objective < 1,
        `ratio objective 应在 (0,1): ${slo.id}`,
      );
    } else {
      assert(slo.objective > 0, `threshold objective 应为正数: ${slo.id}`);
      assert(
        slo.comparison === ">" || slo.comparison === "<",
        `threshold comparison 非法: ${slo.id}`,
      );
    }
    assert(slo.sli.trim().length > 0, `SLI 不能为空: ${slo.id}`);
    assert(
      slo.runbook.startsWith("deploy/monitoring/runbooks/"),
      "runbook 路径应指向 runbooks",
    );
  }
});
