// 月度质量审计入口。
// 目前运行仓库级门禁；后续可扩展覆盖率趋势、文档漂移扫描等。
import { run } from "./gate-runner.ts";

if (import.meta.main) {
  console.log("== 质量审计：仓库级门禁 ==");
  await run(["deno", "run", "-A", "scripts/check-ci.ts"]);
  console.log("质量审计通过");
}
