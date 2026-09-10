// CI 静态检查入口。
// 只运行仓库级门禁，供 CI static lane 使用；模块级检查仍在各模块 job 中执行。
import { run } from "./gate-runner.ts";

if (import.meta.main) {
  console.log("== CI 仓库级门禁 ==");
  await run(["deno", "run", "-A", "scripts/verify-agent-note-format.ts"]);
  await run(["deno", "run", "-A", "scripts/verify-md-links.ts"]);
  await run(["deno", "run", "-A", "scripts/verify-export-jsdoc.ts"]);
  await run(["deno", "run", "-A", "scripts/verify-capability-seams.ts"]);
  await run(["deno", "run", "-A", "scripts/verify-domain-ci.ts"]);
  await run(["deno", "run", "-A", "scripts/silent-skip-report.ts"]);
  await run(["deno", "run", "-A", "scripts/deploy/verify-build-server.ts"]);
  await run(["deno", "run", "-A", "scripts/deploy/verify-compose-server.ts"]);
  await run([
    "deno",
    "test",
    "-A",
    "scripts/deploy/verify-build-server_test.ts",
    "scripts/deploy/verify-compose-server_test.ts",
  ]);
  await run(["deno", "run", "-A", "scripts/gen-event-catalog.ts", "--check"]);
  await run(["deno", "run", "-A", "scripts/gen-route-catalog.ts", "--check"]);
  await run(["deno", "run", "-A", "scripts/check-domains.ts"]);
  await run(["deno", "run", "-A", "scripts/check-metrics.ts"]);
  await run(["deno", "run", "-A", "scripts/check-runtime-contract.ts"]);
  await run(["deno", "run", "-A", "scripts/check-runbooks.ts"]);
  await run(["deno", "run", "-A", "scripts/gen-alert-rules.ts", "--check"]);
  await run(["bash", "scripts/deploy/test-monitoring.sh"]);
  await run([
    "deno",
    "test",
    "-A",
    "scripts/check-domains_test.ts",
    "scripts/check-metrics_test.ts",
    "scripts/check-runtime-contract_test.ts",
    "scripts/check-runbooks_test.ts",
    "scripts/gen-alert-rules_test.ts",
  ]);
  console.log("CI 仓库级门禁通过");
}
