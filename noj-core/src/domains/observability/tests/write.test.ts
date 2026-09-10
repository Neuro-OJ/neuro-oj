import { observability, registerBusinessMetric } from "../write.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("write: registerBusinessMetric 后可以写入", () => {
  registerBusinessMetric({
    name: "noj_submission_e2e_duration_seconds",
    help: "提交端到端耗时",
    type: "histogram",
    owner: "submission",
    labels: ["result"],
  });
  observability.observe("noj_submission_e2e_duration_seconds", 1.5, {
    result: "accepted",
  });
  assert(
    observability.count("noj_submission_e2e_duration_seconds") === 1,
    "应记录 1 个样本",
  );
});
