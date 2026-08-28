// 覆盖率门禁入口（当前可用模块）。
// 运行 noj-llm-gateway 与 noj-ui 覆盖率；core/judge 因 coverage 模式问题暂跳过。
import { run } from "./gate-runner.ts";

if (import.meta.main) {
  console.log("== noj-llm-gateway coverage ==");
  await run(["deno", "task", "test:coverage"], "noj-llm-gateway");

  console.log("== noj-ui coverage ==");
  await run(["deno", "task", "test:coverage"], "noj-ui");

  console.warn(
    "noj-core / noj-judge 覆盖率门禁暂未启用：noj-core 在 coverage 模式下有测试失败，noj-judge 缺少 cargo-llvm-cov。",
  );
  console.log("覆盖率门禁完成");
}
