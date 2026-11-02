/**
 * `deno task test:parallel` 的分片计划（单一事实源）。
 *
 * 分片不再是手抄的目录清单：启动器先发现**实际存在的测试文件**，排除登记在案的
 * 性能基准，按 P0 文件耗时基线降序分配到当前累计耗时最少的分片。这样可以：
 * 1. 新增/删除/重命名测试文件后自动进入计划，不依赖人工维护分片表；
 * 2. 每个非迁移测试文件恰好执行一次（`tests/00_migrate_test.ts` 是唯一例外，
 *    每个分片都要在自己的克隆库上验证正式迁移）；
 * 3. 分片耗时可控（新文件用基线中位耗时估值，避免大文件全挤进同一片）。
 *
 * 本模块只在函数内部读文件系统，导入时不产生副作用，因此可被 `test:logic`
 * 的零依赖测试直接使用。
 */
import { allTargetModuleTestRoots } from "../../scripts/module-test-metadata.ts";

/** 默认分片数：4 片覆盖当前约 440 个 Core 测试文件。 */
export const DEFAULT_SHARD_COUNT = 4;
/** 默认同时运行的分片数；每片都要独立 DB/Redis/存储，不能盲目放大。 */
export const DEFAULT_JOB_COUNT = 2;
/** 分片数上限：继续增加只会放大模板克隆与容器创建成本。 */
export const MAX_SHARD_COUNT = 8;
/** 并行度上限：每个 child 都占用一个数据库与一个 Redis 容器。 */
export const MAX_JOB_COUNT = 8;
/** 唯一允许跨分片重复的测试文件（每片需各自验证正式迁移）。 */
export const MIGRATION_TEST_FILE = "tests/00_migrate_test.ts";
/** 基线里查不到的新文件按此中位耗时估值（毫秒），基线存在时由基线中位数替换。 */
export const FALLBACK_FILE_DURATION_MS = 1_500;

/** 共享测试根：`tests/` 顶层测试、共享 helper 测试与跨模块测试。 */
export const SHARED_TEST_ROOTS = ["tests"] as const;

/** 单个分片的执行计划。 */
export interface Shard {
  /** 稳定名称：`shard1`…`shardN`，同时用于数据库、Redis 标签与存储目录。 */
  name: string;
  /** 该分片要执行的测试文件（迁移入口固定在首位），仓库相对路径。 */
  files: string[];
  /** 按基线/中位数估值的分片耗时（毫秒），仅用于调度与报告。 */
  estimatedMs: number;
}

/** 文件级耗时基线的解析结果。 */
export interface FileDurationBaseline {
  version: number;
  generatedAt: string;
  source: string;
  /** 仓库（noj-core）相对路径 → 实测耗时毫秒。 */
  files: Record<string, number>;
}

/** 一次分片计划的完整输入与产出，供启动器写报告与零依赖测试断言。 */
export interface ShardPlan {
  shardCount: number;
  jobs: number;
  /** 发现后进入计划的全部测试文件（含迁移入口一次），已去重排序。 */
  selectedFiles: string[];
  /** 被显式排除的性能基准文件。 */
  excludedFiles: string[];
  shards: Shard[];
  baseline: {
    /** 基线来源；未读到基线时为 `none`。 */
    source: string;
    generatedAt: string;
    knownFiles: number;
    /** 未知文件的估值（毫秒）：基线中位数或内置回退值。 */
    unknownMs: number;
  };
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
  const normalized = normalizeTestPath(relativePath);
  return PERF_EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * 路径规范化：去掉 `./` 前缀、折叠重复分隔符与结尾斜杠，统一为仓库相对路径。
 *
 * 只做字符串层面的规范化（不解析 `..`）：分片计划只接受由发现逻辑产生的
 * 真实测试文件路径，接受越界路径会让清理与报告不可审计。
 */
export function normalizeTestPath(relativePath: string): string {
  return relativePath
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

/** Deno 测试运行器会发现的文件名约定（与 `test:logic` 的检查口径一致）。 */
export function isTestFileName(fileName: string): boolean {
  return /(?:_test|\.test)\.ts$/.test(fileName);
}

/** 分片发现时要跳过的目录：依赖、缓存、构建产物与嵌套仓库。 */
const DISCOVERY_SKIP_DIRS = new Set([
  "node_modules",
  ".deno_cache",
  ".deno_cov_cache",
  ".test-cache",
  ".test-storage",
  ".git",
  ".jj",
  ".output",
  ".nuxt",
  "coverage",
  "dist",
  "bin",
  "target",
]);

/** 一次测试文件发现的结果；`excluded` 只记录被登记的 perf 文件。 */
export interface TestFileDiscovery {
  files: string[];
  /** 被性能基准前缀排除的文件（相对路径，升序）。 */
  excluded: string[];
  /** 元数据登记但当前不存在的测试根（迁移期/尚未创建），由启动器显式打印。 */
  missingRoots: string[];
}

async function walkTestFiles(
  rootDir: string,
  relativeDir: string,
  out: TestFileDiscovery,
): Promise<void> {
  const absoluteDir = relativeDir ? `${rootDir}/${relativeDir}` : rootDir;
  for await (const entry of Deno.readDir(absoluteDir)) {
    if (entry.isDirectory) {
      if (DISCOVERY_SKIP_DIRS.has(entry.name)) continue;
      await walkTestFiles(
        rootDir,
        relativeDir ? `${relativeDir}/${entry.name}` : entry.name,
        out,
      );
      continue;
    }
    if (!entry.isFile || !isTestFileName(entry.name)) continue;
    const relativePath = normalizeTestPath(
      relativeDir ? `${relativeDir}/${entry.name}` : entry.name,
    );
    if (isPerfExcluded(relativePath)) {
      out.excluded.push(relativePath);
    } else {
      out.files.push(relativePath);
    }
  }
}

/**
 * 从共享根与全部目标模块测试根发现实际存在的测试文件。
 *
 * @param rootDir - noj-core 模块根目录（绝对或相对路径）
 * @param roots - 额外测试根；默认使用 `tests` 与 module 元数据推导的模块根
 * @returns 去重、规范化并升序排序的测试文件列表、perf 排除清单与缺失测试根
 */
export async function discoverTestFiles(
  rootDir: string,
  roots: readonly string[] = [
    ...SHARED_TEST_ROOTS,
    ...allTargetModuleTestRoots(),
  ],
): Promise<TestFileDiscovery> {
  const normalizedRoot = rootDir.replace(/\/+$/, "");
  const seen = new Set<string>();
  const excluded = new Set<string>();
  const missingRoots: string[] = [];
  for (const root of [...new Set(roots.map(normalizeTestPath))]) {
    const discovery: TestFileDiscovery = {
      files: [],
      excluded: [],
      missingRoots: [],
    };
    try {
      await walkTestFiles(normalizedRoot, root, discovery);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        // 迁移期模块根可能尚未创建；由启动器统一打印，避免每个根一条噪声。
        missingRoots.push(root);
        continue;
      }
      throw error;
    }
    for (const file of discovery.files) seen.add(file);
    for (const file of discovery.excluded) excluded.add(file);
  }
  return {
    files: [...seen].sort(),
    excluded: [...excluded].sort(),
    missingRoots: missingRoots.sort(),
  };
}

/** 计算中位数；空数组返回 undefined。 */
export function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

/**
 * 读取文件级耗时基线并校验最小结构。
 *
 * 基线缺失/损坏时抛错：静默退化成"全用中位数"会让分片调度失去依据，却仍在报告
 * 里显示为均衡。
 */
export async function loadFileDurationBaseline(
  path: string,
): Promise<FileDurationBaseline> {
  const parsed = JSON.parse(await Deno.readTextFile(path)) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`测试耗时基线不是对象：${path}`);
  }
  const baseline = parsed as Partial<FileDurationBaseline>;
  if (baseline.version !== 1) {
    throw new Error(`不支持的测试耗时基线版本：${String(baseline.version)}`);
  }
  if (typeof baseline.generatedAt !== "string" || !baseline.generatedAt) {
    throw new Error("测试耗时基线缺少 generatedAt");
  }
  if (typeof baseline.source !== "string" || !baseline.source) {
    throw new Error("测试耗时基线缺少 source（必须说明数据来源）");
  }
  if (!baseline.files || typeof baseline.files !== "object") {
    throw new Error("测试耗时基线缺少 files 映射");
  }
  const files: Record<string, number> = {};
  for (const [file, duration] of Object.entries(baseline.files)) {
    if (
      typeof duration !== "number" || !Number.isFinite(duration) || duration < 0
    ) {
      throw new Error(`测试耗时基线中 ${file} 的耗时不合法：${duration}`);
    }
    files[normalizeTestPath(file)] = duration;
  }
  return {
    version: 1,
    generatedAt: baseline.generatedAt,
    source: baseline.source,
    files,
  };
}

/** 基线不可用时的空基线；调用方仍会显式记录来源为 `none`。 */
export function emptyBaseline(): FileDurationBaseline {
  return {
    version: 1,
    generatedAt: new Date(0).toISOString(),
    source: "none",
    files: {},
  };
}

/**
 * 按基线把测试文件分配到 N 个分片。
 *
 * 规则（与计划一致）：
 * 1. 迁移入口从候选中移除，稍后固定加入每个分片（唯一允许跨分片重复的文件）；
 * 2. 候选按耗时降序排序，同耗时按路径升序，保证同一输入永远产出同一计划；
 * 3. 每个文件分配给当前累计耗时最少的分片，平局取较小分片序号；
 * 4. 分片内文件升序排序，迁移入口固定在首位（Deno 按参数顺序执行）。
 *
 * @param files - 已发现并排除 perf 的测试文件（可含重复/未规范化路径）
 * @param shardCount - 分片数（≥1）
 * @param durations - 已知耗时映射；查不到的文件用中位数
 * @param unknownMs - 未知文件估值（毫秒）
 */
export function partitionTestFiles(
  files: readonly string[],
  shardCount: number,
  durations: Record<string, number> = {},
  unknownMs = FALLBACK_FILE_DURATION_MS,
): Shard[] {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error(`分片数必须为 ≥1 的整数，实际 ${shardCount}`);
  }
  const unique = [
    ...new Set(files.map(normalizeTestPath).filter((file) => file.length > 0)),
  ].sort();
  const hasMigration = unique.includes(MIGRATION_TEST_FILE);
  const candidates = unique.filter((file) => file !== MIGRATION_TEST_FILE);

  const shards: Shard[] = Array.from({ length: shardCount }, (_, index) => ({
    name: `shard${index + 1}`,
    files: [],
    estimatedMs: 0,
  }));

  const weighted = candidates.map((file) => ({
    file,
    duration: durations[file] ?? unknownMs,
  }));
  weighted.sort((left, right) =>
    right.duration === left.duration
      ? left.file < right.file ? -1 : left.file === right.file ? 0 : 1
      : right.duration - left.duration
  );

  for (const { file, duration } of weighted) {
    let target = shards[0]!;
    for (const shard of shards) {
      if (shard.estimatedMs < target.estimatedMs) target = shard;
    }
    target.files.push(file);
    target.estimatedMs += duration;
  }

  const migrationCost = hasMigration
    ? durations[MIGRATION_TEST_FILE] ?? unknownMs
    : 0;
  for (const shard of shards) {
    shard.files.sort();
    if (hasMigration) {
      shard.files = [MIGRATION_TEST_FILE, ...shard.files];
      shard.estimatedMs += migrationCost;
    }
  }
  return shards;
}

/**
 * 组装完整分片计划：发现 → 去重 → 排除 perf → 估值 → 分配 → 记录基线来源。
 *
 * @param files - 已发现的测试文件
 * @param excluded - 被排除的性能基准文件
 * @param shardCount - 分片数
 * @param jobs - 同时运行的分片数
 * @param baseline - 文件级耗时基线
 */
export function buildShardPlan(
  files: readonly string[],
  excluded: readonly string[],
  shardCount: number,
  jobs: number,
  baseline: FileDurationBaseline,
): ShardPlan {
  const knownDurations = Object.values(baseline.files);
  const baselineMedian = median(knownDurations);
  const unknownMs = baselineMedian ?? FALLBACK_FILE_DURATION_MS;
  const selected = [
    ...new Set(files.map(normalizeTestPath).filter((file) => file.length > 0)),
  ].sort();
  if (!selected.includes(MIGRATION_TEST_FILE)) {
    throw new Error(
      `分片计划缺少迁移入口 ${MIGRATION_TEST_FILE}；拒绝在没有迁移验证的分片上运行`,
    );
  }
  return {
    shardCount,
    jobs,
    selectedFiles: selected,
    excludedFiles: [...new Set(excluded.map(normalizeTestPath))].sort(),
    shards: partitionTestFiles(
      selected,
      shardCount,
      baseline.files,
      unknownMs,
    ),
    baseline: {
      source: baseline.source,
      generatedAt: baseline.generatedAt,
      knownFiles: Object.keys(baseline.files).length,
      unknownMs,
    },
  };
}

/**
 * 覆盖守卫：断言每个非 perf 测试文件恰好出现在一个分片中，迁移入口出现在每一片。
 *
 * @returns 违规说明列表；空数组表示计划完整
 */
export function auditShardPlan(plan: ShardPlan): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const shard of plan.shards) {
    const local = new Set<string>();
    for (const file of shard.files) {
      if (local.has(file)) {
        problems.push(`分片 ${shard.name} 重复包含 ${file}`);
        continue;
      }
      local.add(file);
      if (file === MIGRATION_TEST_FILE) continue;
      const previous = seen.get(file);
      if (previous) {
        problems.push(`${file} 同时出现在 ${previous} 与 ${shard.name}`);
      }
      seen.set(file, shard.name);
    }
    if (!local.has(MIGRATION_TEST_FILE)) {
      problems.push(`分片 ${shard.name} 缺少迁移入口 ${MIGRATION_TEST_FILE}`);
    }
  }
  const expected = plan.selectedFiles.filter((file) =>
    file !== MIGRATION_TEST_FILE
  );
  const missing = expected.filter((file) => !seen.has(file));
  if (missing.length > 0) {
    problems.push(`以下测试文件未被任何分片执行：${missing.join("、")}`);
  }
  for (const file of plan.excludedFiles) {
    if (seen.has(file)) {
      problems.push(`性能基准 ${file} 不应进入普通分片`);
    }
  }
  return problems;
}
