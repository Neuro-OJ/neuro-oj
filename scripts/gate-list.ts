/**
 * 仓库级门禁清单（**单一事实源**）。
 *
 * `check-ci.ts`（CI root-gates）与 `check-all.ts`（本地全量检查）均从本文件的
 * `REPO_GATES` 派生，分叉由 `scripts/gate-list_test.ts` 守护。
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
  // 结构与功能边界门禁自测
  "scripts/check-module-boundaries_test.ts",
  "scripts/check-feature-boundaries_test.ts",
  "scripts/select-core-ci_test.ts",
  "scripts/check-test-discovery_test.ts",
  "scripts/check-migration-safety_test.ts",
  "scripts/check-migration-snapshot-chain_test.ts",
  "scripts/verify-compile-safe-imports_test.ts",
  "scripts/gen-route-catalog_test.ts",
  "scripts/check-version-consistency_test.ts",
  "scripts/check-release-version_test.ts",
  "scripts/check-prod-env-injection_test.ts",
  // deno.lock → package-lock 转换器（osv-scanner 无 deno.lock 提取器，见 issue #661）
  "scripts/security/deno-lock-to-package-lock_test.ts",
  "scripts/gate-list_test.ts",
  "scripts/test-baseline_test.ts",
  "scripts/test-duration-baseline_test.ts",
  "scripts/lib/test-timing_test.ts",
  "scripts/test-performance-report_test.ts",
  "scripts/e2e/session_test.ts",
  "scripts/verify-md-links_test.ts",
  "scripts/deploy/install-sh_test.ts",
  "scripts/gen-api-contracts_test.ts",
];

/**
 * 仓库级门禁（两个入口共用；顺序即执行顺序）。
 *
 * 新增门禁请**只**加到本清单，不要再写进任一入口文件。
 */
export const REPO_GATES: Gate[] = [
  { args: ["deno", "run", "-A", "scripts/verify-md-links.ts"] },
  // deno compile 导入安全：变量说明符的动态导入无法内联进生产二进制
  { args: ["deno", "run", "-A", "scripts/verify-compile-safe-imports.ts"] },
  { args: ["deno", "run", "-A", "scripts/verify-domain-ci.ts"] },
  {
    label: "E2E 启动脚本闸门（项目名隔离 + SDK 构建失败传播）",
    args: ["bash", "scripts/e2e/check-setup.sh"],
  },
  {
    label: "E2E LLM Mock 只读接口契约检查",
    args: ["python3", "-B", "scripts/e2e/check_llm_mock.py"],
  },
  {
    label: "测试文件可发现性（check-test-discovery）",
    args: ["deno", "run", "-A", "scripts/check-test-discovery.ts"],
  },
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
  {
    label: "P3 模块边界严格门禁",
    args: [
      "deno",
      "run",
      "-A",
      "scripts/check-module-boundaries.ts",
      "--strict",
    ],
  },
  { args: ["deno", "run", "-A", "scripts/check-feature-boundaries.ts"] },
  { args: ["deno", "run", "-A", "scripts/check-migration-safety.ts"] },
  { args: ["deno", "run", "-A", "scripts/check-migration-snapshot-chain.ts"] },
  { args: ["deno", "run", "-A", "scripts/check-knowledge-pack.ts"] },
  { args: ["deno", "run", "-A", "scripts/gen-api-contracts.ts", "--check"] },
  {
    args: [
      "deno",
      "run",
      "-A",
      "noj-core/scripts/gen-problem-templates.ts",
      "--check",
    ],
  },
  {
    args: ["deno", "run", "-A", "noj-cli/src/problem/gen-skill.ts", "--check"],
  },
  { args: ["deno", "run", "-A", "scripts/check-version-consistency.ts"] },
  { args: ["deno", "run", "-A", "scripts/check-release-version.ts"] },
  { args: ["deno", "run", "-A", "scripts/check-prod-env-injection.ts"] },
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
