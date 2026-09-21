/**
 * 仓库级门禁清单（**单一事实源**）。
 *
 * 背景（2026-09-21 架构收敛）：`check-all.ts`（本地全量检查入口）与
 * `check-ci.ts`（CI 门禁入口）此前各自维护一份手写的门禁列表，长期分叉——
 * 实测 `check-all.ts` 比 `check-ci.ts` **少 19 项**（静默跳过棘轮、迁移安全、
 * 迁移快照链、日志迁移/一致性、单文件规模、写端点限流、Deno 版本、schema
 * 一致性，以及 9 个门禁自测）。后果是本地 `deno run -A scripts/check-all.ts`
 * 显示"全部检查通过"，而同一份代码在 CI 上红灯——典型的"本地假绿"。
 *
 * 现在两个入口都从本文件的 `REPO_GATES` 派生：
 * - `check-ci.ts` 跑 `REPO_GATES`（CI 的 root-gates job 使用）；
 * - `check-all.ts` 跑 `REPO_GATES` + `MODULE_CHECKS`（本地额外补齐各模块的
 *   `deno task check`；CI 侧这些由各模块独立 job 并行执行，故不重复）。
 *
 * 分叉由 `scripts/gate-list_test.ts` 守护：断言两个入口都从本清单派生、
 * 且 `check-all` 覆盖 `check-ci` 的全部门禁。
 */

/** 单条门禁。 */
export interface Gate {
  /** 日志中显示的名称（省略时由 args 自动生成）。 */
  label?: string;
  /** 完整命令（cmd + args）。 */
  args: string[];
  /** 工作目录（相对仓库根；省略为仓库根）。 */
  cwd?: string;
}

/** 门禁自测文件（`deno test` 一次跑完，避免启动多次 Deno）。 */
export const GATE_SELF_TESTS: string[] = [
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
];

/**
 * 仓库级门禁（两个入口共用；顺序即执行顺序）。
 *
 * 新增门禁请**只**加到本清单，不要再写进任一入口文件。
 */
export const REPO_GATES: Gate[] = [
  { args: ["deno", "run", "-A", "scripts/verify-agent-note-format.ts"] },
  { args: ["deno", "run", "-A", "scripts/verify-md-links.ts"] },
  { args: ["deno", "run", "-A", "scripts/verify-export-jsdoc.ts"] },
  { args: ["deno", "run", "-A", "scripts/verify-capability-seams.ts"] },
  { args: ["deno", "run", "-A", "scripts/verify-domain-ci.ts"] },
  // 静默跳过：与基线比对，**跳过数增长即失败**（2026-09-12 评审 §5.1）。
  {
    label: "静默跳过棘轮（silent-skip-report --check）",
    args: ["deno", "run", "-A", "scripts/silent-skip-report.ts", "--check"],
  },
  // 测试文件可发现性：防止「写了 Deno.test 但文件名不匹配运行器约定、
  // 永不执行却显示绿色」这类静默失效（实测案例：noj-core/tests/routes/health.ts）。
  {
    label: "测试文件可发现性（check-test-discovery）",
    args: ["deno", "run", "-A", "scripts/check-test-discovery.ts"],
  },
  { args: ["deno", "run", "-A", "scripts/check-dashboards.ts"] },
  { args: ["deno", "run", "-A", "scripts/deploy/verify-build-server.ts"] },
  { args: ["deno", "run", "-A", "scripts/deploy/verify-compose-server.ts"] },
  {
    args: [
      "deno",
      "test",
      "-A",
      "scripts/deploy/verify-build-server_test.ts",
      "scripts/deploy/verify-compose-server_test.ts",
    ],
  },
  { args: ["deno", "run", "-A", "scripts/gen-event-catalog.ts", "--check"] },
  { args: ["deno", "run", "-A", "scripts/gen-route-catalog.ts", "--check"] },
  { args: ["deno", "run", "-A", "scripts/check-domains.ts"] },
  // 迁移安全：拦截"向已有表加 NOT NULL 列但无 DEFAULT"（存量库升级必失败，
  // 空库测试无法发现——见 2026-09-12 评审 §2.1 与 drizzle/0080）。
  { args: ["deno", "run", "-A", "scripts/check-migration-safety.ts"] },
  // 迁移快照链：drizzle/meta/*_snapshot.json 丢表会让下一次 db:generate 重新生成
  // CREATE TABLE，空库测试通过而**存量部署必失败**（2026-09-14 实测：search_entries
  // 自 0076 起从快照链消失，0082 因此生成了重复建表语句）。
  { args: ["deno", "run", "-A", "scripts/check-migration-snapshot-chain.ts"] },
  { args: ["deno", "run", "-A", "scripts/check-metrics.ts"] },
  { args: ["deno", "run", "-A", "scripts/check-runtime-contract.ts"] },
  { args: ["deno", "run", "-A", "scripts/check-runbooks.ts"] },
  // 日志模板语法：LogTape 把 `{...}` 当占位符且**失败是静默的**，
  // 残留的 JS 模板字符串会被当作占位符消费而不报错，只能静态拦住。
  { args: ["deno", "run", "-A", "scripts/check-log-migration.ts"] },
  // 跨运行时日志渲染一致性：core 与 gateway 的渲染实现刻意独立
  // （跨模块相对导入会破坏 deno check 与 exports 边界），只能靠同一组
  // fixture 逐字符锁定等价，否则「统一日志渲染」会静默漂移。
  { args: ["deno", "run", "-A", "scripts/check-log-parity.ts"] },
  { args: ["deno", "run", "-A", "scripts/gen-alert-rules.ts", "--check"] },
  // 单文件规模棘轮：存量巨型文件不得继续变大，新文件超阈值直接失败（评审 §3.2）
  { args: ["deno", "run", "-A", "scripts/check-file-size.ts"] },
  // 写端点限流覆盖：含写路由的文件必须有有限流证据或在白名单登记（评审 §4.6）
  { args: ["deno", "run", "-A", "scripts/check-write-rate-limits.ts"] },
  // Deno 版本一致性（2026-09-17）：CI 曾用浮动 v2.x，2.9.7 发布引入 BrokenPipe
  // 回归导致 UI Components 间歇红灯。.dvmrc 为唯一事实源，禁止写死 deno-version。
  { args: ["deno", "run", "-A", "scripts/check-deno-version.ts"] },
  // schema-ddl.ts（PGlite 测试用手工 SQL 镜像）与 Drizzle schema 的表/列一致性
  //（2026-09-12 评审 §3.3）。脚本置于 noj-core 下以便解析其导入映射。
  {
    args: ["deno", "run", "-A", "scripts/check-schema-parity.ts"],
    cwd: "noj-core",
  },
  {
    args: ["deno", "test", "-A", "scripts/check-schema-parity_test.ts"],
    cwd: "noj-core",
  },
  // T24：被删脚本的测试（test-deploy/test-backup/test-restore-drill/
  // test-monitoring 等）随之移除——它们测的是已删除的 bash 实现，
  // 其行为覆盖已由 noj-cli 的 TS 测试承接（prod/*_test.ts）。
  // 取而代之的是**弃用闸门**测试：过渡期保留的 deploy.sh/restore-drill.sh
  // 必须继续受 R2 闸门保护（警告 + y 确认 + 非 TTY 不挂起 + 零副作用）。
  { args: ["bash", "scripts/deploy/test-deprecation-gate.sh"] },
  { args: ["deno", "test", "-A", ...GATE_SELF_TESTS] },
];

/**
 * 模块级 `deno task check`（仅本地全量入口）。
 *
 * CI 侧这些由各模块的独立 job 并行执行（core-quick-check / gateway-check /
 * ui-check 等），故 root-gates 不重复跑；本地一次性补齐以保证"本地全绿 =
 * CI 全绿"的口径。
 */
export const MODULE_CHECKS: Gate[] = [
  { label: "noj-core check", args: ["deno", "task", "check"], cwd: "noj-core" },
  {
    label: "noj-llm-gateway check",
    args: ["deno", "task", "check"],
    cwd: "noj-llm-gateway",
  },
  { label: "noj-ui check", args: ["deno", "task", "check"], cwd: "noj-ui" },
];

/** 由 args 生成人类可读的日志标签。 */
export function gateLabel(gate: Gate): string {
  if (gate.label) return gate.label;
  return gate.args.join(" ");
}
