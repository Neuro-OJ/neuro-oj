/**
 * `deno task test:parallel` 的分片配置（单一事实源）。
 *
 * 从 `test-parallel.ts` 抽出为**纯数据 + 纯函数**模块，原因有二：
 * 1. `test-parallel.ts` 有顶层副作用（读 `DATABASE_URL`、spawn 子进程），
 *    无法被测试直接 import；
 * 2. 分片目录集合一旦与实际测试布局漂移（漏掉某个 domain / 顶层测试文件），
 *    那些用例就**永远不会在并行路径下执行**，且没有任何信号。
 *
 * 抽出后，`noj-core/tests/scripts/test-parallel-coverage.test.ts` 可断言
 * 「`tests/` 与 `src/domains/<domain>/tests` 下的每个测试文件都至少被一个分片覆盖」，
 * 把配置漂移变成一次可发现的失败。
 */

export interface Shard {
  name: string;
  schema: string;
  redisDb: number;
  storageDir: string;
  s3Bucket: string;
  dirs: string[];
}

/**
 * 分片配置。
 *
 * 目录集合须与 `.github/workflows/ci.yml` 的 `core-<domain>` / `core-shared`
 * job 覆盖一致；unit 分片多带 `tests/00_migrate_test.ts`——本脚本所有分片都走
 * 真实 PG + TEST_SCHEMA 隔离，需要它在每个分片 schema 内执行迁移；而 CI 的
 * `core-quick-check` / `core-shared` 之外的域 job 走真实 PG，无需额外迁移。
 *
 * 2026-09-21 修复：此前 `observability` / `admin` 两个 domain 的测试、以及
 * `tests/` 顶层若干文件（security-headers / types_safety / defensive-patterns /
 * smoke / scripts）都不在任何分片内，`test:parallel`（CI 的 core-test-sharded
 * job）从不执行它们——尽管本文件的注释声称与 CI 域 job 一致。已补齐。
 *
 * **`perf` 目录刻意排除**：`tests/perf/` 与 `src/domains/<domain>/tests/perf/` 由
 * `NOJ_RUN_PERF=1` 守卫、需外部 DB 与 10 万行种子，只在 main push / 手动触发
 * 的 `core-perf` job 跑，不进入并行分片（见覆盖守卫测试的白名单）。
 */
export const SHARDS: Shard[] = [
  {
    name: "unit",
    schema: "test_unit",
    redisDb: 1,
    storageDir: "",
    s3Bucket: "noj-test-unit",
    dirs: [
      "tests/00_migrate_test.ts",
      "tests/shared",
      "src/domains/identity/tests/lib",
      "src/domains/catalog/tests/lib",
      "src/domains/identity/tests/middleware",
      "src/domains/system/tests/middleware",
      "src/domains/admin/tests/middleware",
      "src/domains/catalog/tests/types",
      "src/domains/contest/tests/types",
      "src/domains/submission/tests/types",
      "src/domains/observability/tests",
      "src/domains/search/tests/consumer",
      "tests/data",
      "tests/app.test.ts",
      "tests/defensive-patterns_test.ts",
      "tests/security-headers.test.ts",
      "tests/types_safety_test.ts",
    ],
  },
  {
    name: "db",
    schema: "test_db",
    redisDb: 2,
    storageDir: ".test-storage/db",
    s3Bucket: "noj-test-db",
    dirs: [
      "tests/00_migrate_test.ts",
      "tests/routes",
      "tests/db",
      "tests/scripts",
      "tests/smoke.test.ts",
      "tests/seed_bootstrap_admin_test.ts",
      "src/domains/identity/tests/routes",
      "src/domains/identity/tests/services",
      "src/domains/catalog/tests/routes",
      "src/domains/catalog/tests/services",
      "src/domains/submission/tests/routes",
      "src/domains/submission/tests/services",
      "src/domains/submission/tests/mq",
      "src/domains/query/tests/routes",
      "src/domains/query/tests/services",
      "src/domains/search/tests/routes",
      "src/domains/search/tests/services",
      "src/domains/contest/tests/routes",
      "src/domains/contest/tests/services",
      "src/domains/community/tests/routes",
      "src/domains/community/tests/services",
      "src/domains/messaging/tests/routes",
      "src/domains/messaging/tests/services",
      "src/domains/objective/tests/routes",
      "src/domains/objective/tests/services",
      "src/domains/system/tests/routes",
      "src/domains/system/tests/services",
      "src/domains/admin/tests/services",
      "src/domains/gateway/tests/services",
      "src/domains/content-review/tests/services",
    ],
  },
];

/** 分片目录参数按前缀覆盖：`tests/routes` 覆盖 `tests/routes/**.ts`。 */
export function isCoveredByShards(
  relativePath: string,
  shards: Shard[] = SHARDS,
): boolean {
  for (const shard of shards) {
    for (const dir of shard.dirs) {
      if (relativePath === dir || relativePath.startsWith(`${dir}/`)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 刻意不进入并行分片的路径前缀（需 `NOJ_RUN_PERF=1` 的性能基准）。
 * 覆盖守卫测试据此排除它们；新增例外必须在此登记并写明理由。
 */
export const PERF_EXCLUDED_PREFIXES = [
  "tests/perf/",
  "src/domains/search/tests/perf/",
] as const;

/** 某测试文件是否属于刻意排除的性能基准。 */
export function isPerfExcluded(relativePath: string): boolean {
  return PERF_EXCLUDED_PREFIXES.some((p) => relativePath.startsWith(p));
}
