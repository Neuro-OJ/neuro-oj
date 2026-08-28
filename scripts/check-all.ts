// 本地全量检查入口。
// 依次运行仓库级门禁与各模块 quick check；任一失败即退出非零。
import { run } from "./gate-runner.ts";

if (import.meta.main) {
  console.log("== 仓库级门禁 ==");
  await run(["deno", "run", "-A", "scripts/verify-agent-note-format.ts"]);
  await run(["deno", "run", "-A", "scripts/verify-md-links.ts"]);
  await run(["deno", "run", "-A", "scripts/verify-export-jsdoc.ts"]);

  console.log("== noj-core check ==");
  await run(["deno", "task", "check"], "noj-core");

  console.log("== noj-llm-gateway check ==");
  await run(["deno", "task", "check"], "noj-llm-gateway");

  console.log("== noj-ui check ==");
  await run(["deno", "task", "check"], "noj-ui");

  console.log("全部检查通过");
}
