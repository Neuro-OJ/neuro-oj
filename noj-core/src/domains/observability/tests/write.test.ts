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
  // 断言渲染文本而非调用内部读数方法：渲染才是对外契约。
  const out = observability.render();
  assert(
    out.includes(
      'noj_submission_e2e_duration_seconds_count{result="accepted"} 1',
    ),
    `应记录 1 个样本，实际渲染：${out}`,
  );
});
