// CI 静态检查入口。
// 只运行仓库级门禁，供 CI static lane 使用；模块级检查仍在各模块 job 中执行。
//
// 门禁清单集中在 `scripts/gate-list.ts`（单一事实源），与本地入口
// `scripts/check-all.ts` 共用，避免两者长期分叉（2026-09-21 收敛）。
import { run } from "./gate-runner.ts";
import { gateLabel, REPO_GATES } from "./gate-list.ts";

if (import.meta.main) {
  console.log("== CI 仓库级门禁 ==");
  for (const gate of REPO_GATES) {
    console.log(`-- ${gateLabel(gate)}`);
    await run(gate.args, gate.cwd);
  }
  console.log("CI 仓库级门禁通过");
}
