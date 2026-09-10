import { renderSloRules } from "./gen-alert-rules.ts";
import { SLOS } from "../noj-core/src/domains/observability/slo.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("gen-alert-rules: SLO id 唯一且 runbook 路径存在", async () => {
  const ids = new Set<string>();
  for (const slo of SLOS) {
    assert(!ids.has(slo.id), `重复 SLO id: ${slo.id}`);
    ids.add(slo.id);
    await Deno.stat(slo.runbook);
  }
});

Deno.test("gen-alert-rules: 渲染结果包含每个 SLO 的告警", () => {
  const out = renderSloRules();
  for (const slo of SLOS) {
    assert(out.includes(slo.id), `渲染应包含 ${slo.id}`);
  }
});
