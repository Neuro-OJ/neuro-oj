/**
 * 并行分片覆盖守卫（P5 重写）。
 *
 * 背景（2026-09-21）：分片目录集合声称与 CI 一致，实际漏掉 observability /
 * admin 与若干顶层测试文件，却没有任何信号。P5 起分片改为"发现实际测试文件
 * 后按耗时分配"，本文件直接对照文件系统与真实计划断言：
 *
 * 1. N=1/2/4 的非迁移测试集合必须相等，且每个文件恰好一次；
 * 2. `tests/00_migrate_test.ts` 是唯一允许跨分片重复的文件（每片都要验证迁移）；
 * 3. 覆盖守卫以文件系统为准（新增/删除/重命名后仍完整），不看手抄清单；
 * 4. 性能基准按登记豁免，且不能混进普通分片；
 * 5. 分片分配必须确定、可复现并保持基本均衡。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  auditShardPlan,
  buildShardPlan,
  DEFAULT_JOB_COUNT,
  discoverTestFiles,
  emptyBaseline,
  FALLBACK_FILE_DURATION_MS,
  FEATURE_TEST_ROOT,
  isPerfExcluded,
  loadFileDurationBaseline,
  median,
  MIGRATION_TEST_FILE,
  normalizeTestPath,
  partitionTestFiles,
  SHARED_TEST_ROOTS,
} from "../../scripts/test-parallel-shards.ts";

const CORE_ROOT = new URL("../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

const BASELINE_PATH = new URL(
  "../../../dev-docs/engineering/test-duration-baseline.json",
  import.meta.url,
).pathname;

/** 独立于生产代码的测试文件遍历：覆盖守卫不能复用被测实现。 */
async function collectTestFilesFromDisk(): Promise<string[]> {
  const out: string[] = [];
  const skip = new Set([
    "node_modules",
    ".deno_cache",
    ".deno_cov_cache",
    ".test-cache",
    ".test-storage",
    ".git",
    ".jj",
    ".output",
    "coverage",
    "bin",
    "dist",
  ]);
  async function walk(dir: string): Promise<void> {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory) {
        if (skip.has(entry.name)) continue;
        await walk(`${dir}/${entry.name}`);
        continue;
      }
      if (!entry.isFile) continue;
      if (!/(?:_test|\.test)\.ts$/.test(entry.name)) continue;
      const absolute = `${dir}/${entry.name}`;
      const relative = normalizeTestPath(absolute.slice(CORE_ROOT.length + 1));
      if (
        relative.startsWith("tests/") ||
        // 功能切片：`src/features/<name>/` 下任意层级都是测试根。
        /^src\/features\//.test(relative) ||
        // 模块测试根可以是嵌套的：`src/modules/access/identity/tests`。
        /^src\/modules\/(?:[^/]+\/)*tests\//.test(relative)
      ) {
        out.push(relative);
      }
    }
  }
  await walk(CORE_ROOT);
  return out.sort();
}

async function realDiscovery() {
  return await discoverTestFiles(CORE_ROOT);
}

Deno.test("shards: 发现的测试文件与文件系统一致（新增/改名自动进入计划）", async () => {
  const discovery = await realDiscovery();
  const onDisk = await collectTestFilesFromDisk();
  assert(
    onDisk.length > 400,
    `磁盘上的测试文件过少，扫描规则可能失效：${onDisk.length}`,
  );
  const planned = new Set([...discovery.files, ...discovery.excluded]);
  const missing = onDisk.filter((file) => !planned.has(file));
  assertEquals(
    missing,
    [],
    `以下测试文件既未进入分片也未登记为 perf 排除（永不执行）：\n${
      missing.map((file) => "  - " + file).join("\n")
    }`,
  );
  const phantom = discovery.files.filter((file) => !onDisk.includes(file));
  assertEquals(phantom, [], "分片计划不得包含磁盘上不存在的文件");
});

Deno.test("shards: 性能基准按登记豁免（而非被静默遗漏）", async () => {
  const discovery = await realDiscovery();
  assert(discovery.excluded.length >= 4, "至少应发现 4 个 perf 基准文件");
  for (const file of discovery.excluded) {
    assert(
      isPerfExcluded(file),
      `未被登记为 perf 的文件不应进入排除清单：${file}`,
    );
  }
  assert(isPerfExcluded("tests/perf/search_bench.test.ts"));
  assert(
    isPerfExcluded(
      "src/modules/read-models/search/tests/perf/search_bench.test.ts",
    ),
  );
  assert(
    isPerfExcluded("src/modules/education/tests/perf/matrix-bench.test.ts"),
  );
  assert(!isPerfExcluded("tests/security-headers.test.ts"));
  assert(
    !discovery.files.some((file) => isPerfExcluded(file)),
    "perf 文件不得出现在普通分片中",
  );
});

Deno.test("shards: N=1/2/4 的非迁移文件集合相等且无重复", async () => {
  const discovery = await realDiscovery();
  const baseline = await loadFileDurationBaseline(BASELINE_PATH);
  const sets: string[][] = [];
  for (const shardCount of [1, 2, 4]) {
    const plan = buildShardPlan(
      discovery.files,
      discovery.excluded,
      shardCount,
      DEFAULT_JOB_COUNT,
      baseline,
    );
    assertEquals(
      plan.shards.length,
      shardCount,
      `N=${shardCount} 必须产生 ${shardCount} 个分片`,
    );
    assertEquals(auditShardPlan(plan), [], `N=${shardCount} 分片计划不完整`);
    const migrated = plan.shards.map((shard) => shard.files[0]);
    assertEquals(
      migrated,
      new Array(shardCount).fill(MIGRATION_TEST_FILE),
      "迁移入口必须固定在每个分片首位",
    );
    for (const shard of plan.shards) {
      assertEquals(
        shard.files.filter((file) => file === MIGRATION_TEST_FILE).length,
        1,
        `分片 ${shard.name} 必须且只能包含一次迁移入口`,
      );
    }
    sets.push(
      plan.shards.flatMap((shard) =>
        shard.files.filter((file) => file !== MIGRATION_TEST_FILE)
      ).sort(),
    );
  }
  const expected = discovery.files
    .filter((file) => file !== MIGRATION_TEST_FILE)
    .sort();
  assert(expected.length > 400, "非迁移测试文件数量异常，守卫可能失效");
  assertEquals(sets[0], expected, "N=1 必须包含全部非迁移测试文件");
  assertEquals(sets[1], expected, "N=2 必须与 N=1 覆盖同一集合");
  assertEquals(sets[2], expected, "N=4 必须与 N=1 覆盖同一集合");
  assertEquals(
    new Set(sets[2]).size,
    sets[2].length,
    "N=4 展开后不得出现重复文件",
  );
});

Deno.test("shards: 计划确定（同一输入两次分配完全一致）", async () => {
  const discovery = await realDiscovery();
  const baseline = await loadFileDurationBaseline(BASELINE_PATH);
  const first = buildShardPlan(
    discovery.files,
    discovery.excluded,
    4,
    2,
    baseline,
  );
  const second = buildShardPlan(
    [...discovery.files].reverse(),
    [...discovery.excluded].reverse(),
    4,
    2,
    baseline,
  );
  assertEquals(
    first.shards.map((shard) => shard.files),
    second.shards.map((shard) => shard.files),
    "输入顺序变化不得改变计划（排序必须稳定）",
  );
});

Deno.test("shards: 按基线降序贪心分配，耗时基本均衡", async () => {
  const discovery = await realDiscovery();
  const baseline = await loadFileDurationBaseline(BASELINE_PATH);
  const plan = buildShardPlan(
    discovery.files,
    discovery.excluded,
    4,
    DEFAULT_JOB_COUNT,
    baseline,
  );
  const loads = plan.shards.map((shard) => shard.estimatedMs);
  const maxFile = Math.max(
    ...Object.values(baseline.files),
    plan.baseline.unknownMs,
  );
  assert(
    Math.max(...loads) - Math.min(...loads) <= maxFile,
    `贪心分配后各片估值差 (${
      loads.join("/")
    }) 不应超过最大单文件耗时 ${maxFile}`,
  );
  // 最大文件必须落在第一片（降序分配的第一个选择），且分片内文件升序。
  const largest =
    Object.entries(baseline.files).sort((a, b) => b[1] - a[1])[0]![0];
  assert(
    plan.shards.some((shard) => shard.files.includes(largest)),
    `最大测试文件 ${largest} 必须进入计划`,
  );
  for (const shard of plan.shards) {
    const body = shard.files.slice(1);
    assertEquals(body, [...body].sort(), `分片 ${shard.name} 内文件必须升序`);
  }
});

Deno.test("shards: 新文件使用基线中位耗时，且未登记者不影响覆盖", () => {
  const baseline = {
    version: 1,
    generatedAt: "2026-11-03T00:00:00.000Z",
    source: "test",
    files: {
      "tests/00_migrate_test.ts": 100,
      "tests/slow.test.ts": 9000,
      "tests/fast.test.ts": 100,
    },
  };
  const unknownMs = median(Object.values(baseline.files))!;
  // [100, 100, 9000] → 中位数 100：新文件按中位耗时估值，而不是按最大值。
  assertEquals(unknownMs, 100);
  const shards = partitionTestFiles(
    [
      "tests/00_migrate_test.ts",
      "tests/slow.test.ts",
      "tests/fast.test.ts",
      "tests/brand-new.test.ts",
    ],
    1,
    baseline.files,
    unknownMs,
  );
  assertEquals(shards.length, 1);
  // 100（迁移）+ 9000 + 100（新文件中位数）+ 100
  assertEquals(shards[0]!.estimatedMs, 9300);
  const plan = buildShardPlan(
    [
      "tests/00_migrate_test.ts",
      "tests/brand-new.test.ts",
    ],
    [],
    2,
    2,
    emptyBaseline(),
  );
  assertEquals(
    plan.baseline.unknownMs,
    FALLBACK_FILE_DURATION_MS,
    "没有基线时使用内置回退值",
  );
  assertEquals(auditShardPlan(plan), []);
});

Deno.test("shards: 路径规范化去重（./tests//x.test.ts 只执行一次）", () => {
  const shards = partitionTestFiles(
    [
      "./tests/a.test.ts",
      "tests//a.test.ts",
      "tests/a.test.ts",
      "tests/00_migrate_test.ts",
    ],
    2,
    {},
    100,
  );
  const nonMigration = shards.flatMap((shard) =>
    shard.files.filter((file) => file !== MIGRATION_TEST_FILE)
  );
  assertEquals(nonMigration, ["tests/a.test.ts"]);
});

Deno.test("shards: 新增/删除/重命名后覆盖守卫发现正确集合", async () => {
  const root = await Deno.makeTempDir({ prefix: "noj-shard-discovery-" });
  const roots = ["tests", "src/modules/demo/tests"];
  try {
    await Deno.mkdir(`${root}/tests/perf`, { recursive: true });
    await Deno.mkdir(`${root}/src/modules/demo/tests`, { recursive: true });
    await Deno.writeTextFile(`${root}/tests/00_migrate_test.ts`, "");
    await Deno.writeTextFile(`${root}/tests/old.test.ts`, "");
    await Deno.writeTextFile(`${root}/tests/perf/bench.test.ts`, "");
    await Deno.writeTextFile(
      `${root}/src/modules/demo/tests/demo_test.ts`,
      "",
    );

    const first = await discoverTestFiles(root, roots);
    assertEquals(first.files, [
      "src/modules/demo/tests/demo_test.ts",
      "tests/00_migrate_test.ts",
      "tests/old.test.ts",
    ]);
    assertEquals(first.excluded, ["tests/perf/bench.test.ts"]);

    // 重命名 + 新增：旧文件消失、新文件自动进入计划。
    await Deno.remove(`${root}/tests/old.test.ts`);
    await Deno.writeTextFile(`${root}/tests/renamed.test.ts`, "");
    const second = await discoverTestFiles(root, roots);
    assertEquals(second.files, [
      "src/modules/demo/tests/demo_test.ts",
      "tests/00_migrate_test.ts",
      "tests/renamed.test.ts",
    ]);
    const plan = buildShardPlan(
      second.files,
      second.excluded,
      1,
      1,
      emptyBaseline(),
    );
    assert(plan.shards[0]!.files.includes("tests/renamed.test.ts"));
    assert(!plan.shards[0]!.files.includes("tests/old.test.ts"));

    // 删除模块根：缺根显式报告，但不得伪造覆盖。
    await Deno.remove(`${root}/src/modules/demo/tests`, { recursive: true });
    const third = await discoverTestFiles(root, roots);
    assertEquals(third.missingRoots, ["src/modules/demo/tests"]);
    assertEquals(third.files, [
      "tests/00_migrate_test.ts",
      "tests/renamed.test.ts",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("shards: 默认发现覆盖 src/features/** 下任意层级的测试", async () => {
  // 功能切片：新增 `src/features/<name>/` 后不需要登记测试路径，并行分片与
  // 全量入口都必须自动发现它（含嵌套子目录、两种文件名约定）。
  const root = await Deno.makeTempDir({ prefix: "noj-shard-features-" });
  try {
    await Deno.mkdir(`${root}/src/features/demo/sub`, { recursive: true });
    await Deno.mkdir(`${root}/tests`, { recursive: true });
    await Deno.writeTextFile(`${root}/tests/00_migrate_test.ts`, "");
    await Deno.writeTextFile(`${root}/src/features/demo/demo.test.ts`, "");
    await Deno.writeTextFile(`${root}/src/features/demo/sub/x_test.ts`, "");
    await Deno.writeTextFile(`${root}/src/features/demo/helper.ts`, "");

    const discovery = await discoverTestFiles(root, [
      ...SHARED_TEST_ROOTS,
      FEATURE_TEST_ROOT,
    ]);
    assertEquals(discovery.files, [
      "src/features/demo/demo.test.ts",
      "src/features/demo/sub/x_test.ts",
      "tests/00_migrate_test.ts",
    ]);
    assertEquals(discovery.missingRoots, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("shards: auditShardPlan 能发现漏跑、重复与 perf 混入", () => {
  const basePlan = {
    shardCount: 2,
    jobs: 1,
    selectedFiles: [
      MIGRATION_TEST_FILE,
      "tests/a.test.ts",
      "tests/b.test.ts",
    ],
    excludedFiles: ["tests/perf/bench.test.ts"],
    shards: [
      {
        name: "shard1",
        files: [MIGRATION_TEST_FILE, "tests/a.test.ts"],
        estimatedMs: 1,
      },
      {
        name: "shard2",
        files: [MIGRATION_TEST_FILE, "tests/b.test.ts"],
        estimatedMs: 1,
      },
    ],
    baseline: {
      source: "test",
      generatedAt: "2026-11-03T00:00:00.000Z",
      knownFiles: 0,
      unknownMs: 1,
    },
  };
  assertEquals(auditShardPlan(basePlan), []);
  assert(
    auditShardPlan({
      ...basePlan,
      shards: [
        basePlan.shards[0]!,
        { name: "shard2", files: [MIGRATION_TEST_FILE], estimatedMs: 1 },
      ],
    }).some((problem) => problem.includes("未被任何分片执行")),
    "漏跑文件必须被报告",
  );
  assert(
    auditShardPlan({
      ...basePlan,
      shards: [
        {
          name: "shard1",
          files: [MIGRATION_TEST_FILE, "tests/a.test.ts", "tests/a.test.ts"],
          estimatedMs: 1,
        },
        basePlan.shards[1]!,
      ],
    }).some((problem) => problem.includes("重复包含")),
    "重复文件必须被报告",
  );
  assert(
    auditShardPlan({
      ...basePlan,
      shards: [
        {
          name: "shard1",
          files: [
            MIGRATION_TEST_FILE,
            "tests/a.test.ts",
            "tests/perf/bench.test.ts",
          ],
          estimatedMs: 1,
        },
        basePlan.shards[1]!,
      ],
    }).some((problem) => problem.includes("性能基准")),
    "perf 文件混入普通分片必须被报告",
  );
  assert(
    auditShardPlan({
      ...basePlan,
      shards: [basePlan.shards[0]!, {
        name: "shard2",
        files: [],
        estimatedMs: 0,
      }],
    }).some((problem) => problem.includes("缺少迁移入口")),
    "缺少迁移入口必须被报告",
  );
});
