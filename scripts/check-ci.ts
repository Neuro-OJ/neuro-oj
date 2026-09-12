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
  // 测试文件可发现性：防止「写了 Deno.test 但文件名不匹配运行器约定、
  // 永不执行却显示绿色」这类静默失效（实测案例：noj-core/tests/routes/health.ts）。
  await run(["deno", "run", "-A", "scripts/check-test-discovery.ts"]);
  await run(["deno", "run", "-A", "scripts/check-dashboards.ts"]);
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
  // 日志模板语法：LogTape 把 `{...}` 当占位符且**失败是静默的**，
  // 残留的 JS 模板字符串会被当作占位符消费而不报错，只能静态拦住。
  await run(["deno", "run", "-A", "scripts/check-log-migration.ts"]);
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
    "scripts/check-test-discovery_test.ts",
    "scripts/check-dashboards_test.ts",
    "scripts/check-log-migration_test.ts",
  ]);
  console.log("CI 仓库级门禁通过");
}
