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
  // 静默跳过：与基线比对，**跳过数增长即失败**（2026-09-12 评审 §5.1）。
  // 此前只生成报告、从不 exit 1，跳过数增长永远发现不了。
  await run(["deno", "run", "-A", "scripts/silent-skip-report.ts", "--check"]);
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
  // 迁移安全：拦截"向已有表加 NOT NULL 列但无 DEFAULT"（存量库升级必失败，
  // 空库测试无法发现——见 2026-09-12 评审 §2.1 与 drizzle/0080）。
  await run(["deno", "run", "-A", "scripts/check-migration-safety.ts"]);
  await run(["deno", "run", "-A", "scripts/check-metrics.ts"]);
  await run(["deno", "run", "-A", "scripts/check-runtime-contract.ts"]);
  await run(["deno", "run", "-A", "scripts/check-runbooks.ts"]);
  await run(["deno", "run", "-A", "scripts/gen-alert-rules.ts", "--check"]);
  // 单文件规模棘轮：存量巨型文件不得继续变大，新文件超阈值直接失败（评审 §3.2）
  await run(["deno", "run", "-A", "scripts/check-file-size.ts"]);
  // 写端点限流覆盖：含写路由的文件必须有有限流证据或在白名单登记（评审 §4.6）
  await run(["deno", "run", "-A", "scripts/check-write-rate-limits.ts"]);
  // schema-ddl.ts（PGlite 测试用手工 SQL 镜像）与 Drizzle schema 的表/列一致性
  //（2026-09-12 评审 §3.3）。脚本置于 noj-core 下以便解析其导入映射。
  await run(
    ["deno", "run", "-A", "scripts/check-schema-parity.ts"],
    "noj-core",
  );
  await run(
    ["deno", "test", "-A", "scripts/check-schema-parity_test.ts"],
    "noj-core",
  );
  await run(["bash", "scripts/deploy/test-monitoring.sh"]);
  // 运维脚本测试（2026-09-12 评审 §5.4）：此前仅 test-monitoring.sh 进 CI，
  // 其余 8 个（约 130KB）零引用。以下三个均为"无 Docker + fake docker"测试。
  await run(["bash", "scripts/deploy/test-deploy.sh"]);
  await run(["bash", "scripts/deploy/test-backup.sh"]);
  await run(["bash", "scripts/deploy/test-restore-drill.sh"]);
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
    "scripts/check-migration-safety_test.ts",
    "scripts/verify-capability-seams_test.ts",
    "scripts/gen-route-catalog_test.ts",
    "scripts/silent-skip-report_test.ts",
    "scripts/check-file-size_test.ts",
    "scripts/check-write-rate-limits_test.ts",
  ]);
  console.log("CI 仓库级门禁通过");
}
