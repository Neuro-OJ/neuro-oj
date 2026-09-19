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
  // 迁移快照链：drizzle/meta/*_snapshot.json 丢表会让下一次 db:generate 重新生成
  // CREATE TABLE，空库测试通过而**存量部署必失败**（2026-09-14 实测：search_entries
  // 自 0076 起从快照链消失，0082 因此生成了重复建表语句）。
  await run(["deno", "run", "-A", "scripts/check-migration-snapshot-chain.ts"]);
  await run(["deno", "run", "-A", "scripts/check-metrics.ts"]);
  await run(["deno", "run", "-A", "scripts/check-runtime-contract.ts"]);
  await run(["deno", "run", "-A", "scripts/check-runbooks.ts"]);
  // 日志模板语法：LogTape 把 `{...}` 当占位符且**失败是静默的**，
  // 残留的 JS 模板字符串会被当作占位符消费而不报错，只能静态拦住。
  await run(["deno", "run", "-A", "scripts/check-log-migration.ts"]);
  // 跨运行时日志渲染一致性：core 与 gateway 的渲染实现刻意独立
  // （跨模块相对导入会破坏 deno check 与 exports 边界），只能靠同一组
  // fixture 逐字符锁定等价，否则「统一日志渲染」会静默漂移。
  await run(["deno", "run", "-A", "scripts/check-log-parity.ts"]);
  await run(["deno", "run", "-A", "scripts/gen-alert-rules.ts", "--check"]);
  // 单文件规模棘轮：存量巨型文件不得继续变大，新文件超阈值直接失败（评审 §3.2）
  await run(["deno", "run", "-A", "scripts/check-file-size.ts"]);
  // 写端点限流覆盖：含写路由的文件必须有有限流证据或在白名单登记（评审 §4.6）
  await run(["deno", "run", "-A", "scripts/check-write-rate-limits.ts"]);
  // Deno 版本一致性（2026-09-17）：CI 曾用浮动 v2.x，2.9.7 发布引入 BrokenPipe
  // 回归导致 UI Components 间歇红灯。.dvmrc 为唯一事实源，禁止写死 deno-version。
  await run(["deno", "run", "-A", "scripts/check-deno-version.ts"]);
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
  // T24：被删脚本的测试（test-deploy/test-backup/test-restore-drill/
  // test-monitoring 等）随之移除——它们测的是已删除的 bash 实现，
  // 其行为覆盖已由 noj-cli 的 TS 测试承接（prod/*_test.ts）。
  // 取而代之的是**弃用闸门**测试：过渡期保留的 deploy.sh/restore-drill.sh
  // 必须继续受 R2 闸门保护（警告 + y 确认 + 非 TTY 不挂起 + 零副作用）。
  await run(["bash", "scripts/deploy/test-deprecation-gate.sh"]);
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
    "scripts/check-migration-snapshot-chain_test.ts",
    "scripts/verify-capability-seams_test.ts",
    "scripts/gen-route-catalog_test.ts",
    "scripts/silent-skip-report_test.ts",
    "scripts/check-file-size_test.ts",
    "scripts/check-write-rate-limits_test.ts",
    "scripts/check-log-migration_test.ts",
    "scripts/check-deno-version_test.ts",
  ]);
  console.log("CI 仓库级门禁通过");
}
