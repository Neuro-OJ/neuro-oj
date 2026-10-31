/**
 * `deno task test:parallel` 的分片目录清单（单一事实源）。
 *
 * 分片使用独立 PostgreSQL 数据库，而不是共享 schema、固定 Redis DB 或
 * 进程级事务代理。数据库、Redis lease 与存储目录的生命周期由
 * `test-launcher.ts` 统一管理；本文件只保留可被零依赖测试导入的目录数据。
 */

import { allTargetModuleTestRoots } from "../../scripts/module-test-metadata.ts";

export interface Shard {
  /** 日志和资源命名使用的稳定名称。 */
  name: string;
  /** 由测试启动器从模板数据库克隆后执行的测试目录。 */
  dirs: string[];
}

/**
 * 分片配置。
 *
 * 同一目录只能出现在一个分片中；`tests/00_migrate_test.ts` 是唯一允许
 * 重复的直接文件路径，因为每个克隆数据库都需要验证正式迁移确实完成。
 * 性能基准单独由 `test:perf` 运行，不进入普通并行回归。
 */
export const SHARDS: Shard[] = [
  {
    // 该分片仍包含真实 DB/Redis 测试（如 tests/shared/db 与 identity/lib），
    // 因此使用 core 名称；纯逻辑测试另由 test:logic 提供。
    name: "core",
    dirs: [
      "tests/00_migrate_test.ts",
      "tests/shared",
      "tests/data",
      "tests/app.test.ts",
      "tests/defensive-patterns_test.ts",
      "tests/security-headers.test.ts",
      "tests/types_safety_test.ts",
    ],
  },
  {
    name: "db",
    dirs: [
      "tests/00_migrate_test.ts",
      "tests/routes",
      "tests/db",
      "tests/scripts",
      "tests/smoke.test.ts",
      "tests/seed_bootstrap_admin_test.ts",
      // 迁移期模块测试与 legacy domain 测试同时进入正式分片。目录由
      // module-boundaries.json 推导，新增 application/http/runtime 测试不会
      // 因忘记手抄一条 shard 路径而静默漏跑。
      ...allTargetModuleTestRoots(),
    ],
  },
];

/** 分片目录参数按前缀覆盖：`tests/routes` 覆盖 `tests/routes/**.ts`。 */
export function isCoveredByShards(
  relativePath: string,
  shards: Shard[] = SHARDS,
): boolean {
  return shards.some((shard) =>
    shard.dirs.some((dir) =>
      relativePath === dir || relativePath.startsWith(`${dir}/`)
    )
  );
}

/**
 * 刻意不进入普通并行分片的性能基准。
 *
 * 这些文件需要显式 `NOJ_RUN_PERF=1`，并由 `test:perf` 创建自己的数据库；
 * 它们必须在这里登记，覆盖守卫才不会把遗漏误报成完整覆盖。
 */
export const PERF_EXCLUDED_PREFIXES = [
  "tests/perf/",
  "src/modules/read-models/search/tests/perf/",
  "src/modules/education/tests/perf/",
] as const;

/** 某测试文件是否属于刻意排除的性能基准。 */
export function isPerfExcluded(relativePath: string): boolean {
  return PERF_EXCLUDED_PREFIXES.some((prefix) =>
    relativePath.startsWith(prefix)
  );
}
