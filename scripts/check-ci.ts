// CI 静态检查入口。
// 只运行仓库级门禁，供 CI static lane 使用；模块级检查仍在各模块 job 中执行。
import { run } from "./gate-runner.ts";

if (import.meta.main) {
  console.log("== CI 仓库级门禁 ==");
  await run(["deno", "run", "-A", "scripts/verify-agent-note-format.ts"]);
  await run(["deno", "run", "-A", "scripts/verify-md-links.ts"]);
  await run(["deno", "run", "-A", "scripts/verify-export-jsdoc.ts"]);
  await run(["deno", "run", "-A", "scripts/verify-capability-seams.ts"]);
  await run(["deno", "run", "-A", "scripts/gen-event-catalog.ts", "--check"]);
  await run(["deno", "run", "-A", "scripts/gen-route-catalog.ts", "--check"]);
  console.log("CI 仓库级门禁通过");
}
