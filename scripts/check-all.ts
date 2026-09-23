// 本地全量检查入口。
// 依次运行仓库级门禁（与 CI 的 root-gates 完全一致）与各模块 quick check；
// 任一失败即退出非零。
//
// 门禁清单集中在 `scripts/gate-list.ts`（单一事实源）。2026-09-21 之前本文件
// 与 `check-ci.ts` 各自维护列表，长期分叉——本地比 CI 少 19 项门禁，导致
// "本地全量检查通过"而 CI 红灯。现在两者从同一清单派生，分叉由
// `scripts/gate-list_test.ts` 守护。
import { run } from "./gate-runner.ts";
import { gateLabel, MODULE_CHECKS, REPO_GATES } from "./gate-list.ts";

if (import.meta.main) {
  console.log("== 仓库级门禁（与 CI root-gates 一致）==");
  for (const gate of REPO_GATES) {
    console.log(`-- ${gateLabel(gate)}`);
    await run(gate.args, gate.cwd);
  }

  console.log("== 模块级 check ==");
  for (const gate of MODULE_CHECKS) {
    console.log(`-- ${gate.label}`);
    await run(gate.args, gate.cwd);
  }

  console.log("全部检查通过");
}
