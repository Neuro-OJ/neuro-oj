/**
 * 统一测试启动器的 CLI 解析。
 *
 * 这个模块只处理参数和目录选择，不读取环境、不连外部服务，便于在
 * `test:logic` 的零依赖逻辑测试中直接验证。
 *
 * 参数语义（P5）：
 * - `--shards N`：把全部所选测试划分成 N 片，默认 4；
 * - `--jobs M`：同时运行最多 M 片，默认 2；每片独立 DB/Redis/存储；
 * - `--profile`：开启 P0 阶段计时，转换为 `NOJ_TEST_PROFILE=1` 并写入报告目录；
 * - `--dry-run`：只输出选择与资源计划，不读取 `TEST_*`、不创建任何外部资源。
 */
import { parseJobArgs, parseShardArgs } from "./test-parallel-args.ts";
import {
  DEFAULT_JOB_COUNT,
  DEFAULT_SHARD_COUNT,
  MAX_JOB_COUNT,
  MAX_SHARD_COUNT,
} from "./test-parallel-shards.ts";
import {
  allTargetModuleTestRoots,
  LEGACY_DOMAIN_NAMES,
  resolveModuleTestTarget,
  TARGET_MODULE_NAMES,
  testRootsForTarget,
} from "../../scripts/module-test-metadata.ts";

/** 启动器入口模式。 */
export type LaunchMode =
  | "test"
  | "domain"
  | "shared"
  | "parallel"
  | "pg"
  | "smoke"
  | "perf"
  | "watch";

/** 解析后的启动器选项。 */
export interface LauncherOptions {
  mode: LaunchMode;
  domain?: string;
  /** 分片数：全部所选测试划分成多少片（默认 4）。 */
  shardCount: number;
  /** 并行度：同时运行多少片（默认 2）。 */
  jobs: number;
  dryRun: boolean;
  runPerf: boolean;
  /** 是否开启阶段计时（`--profile`）。 */
  profile: boolean;
  testArgs: string[];
}

/** 可作为 `test:domain` 入参的模块与 legacy 别名。 */
export const TEST_TARGET_NAMES = [
  ...TARGET_MODULE_NAMES,
  ...LEGACY_DOMAIN_NAMES,
] as const;

/** 允许透传给 Deno test 的 reporter。 */
const TEST_REPORTERS = new Set([
  "pretty",
  "dot",
  "junit",
  "tap",
  "json",
  "github",
]);

function consumeTestOptionValue(
  args: readonly string[],
  index: number,
  option: string,
): { value: string; nextIndex: number } {
  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`测试启动器的 ${option} 缺少值`);
  }
  return { value, nextIndex: index + 1 };
}

function validateReporter(value: string): string {
  if (!TEST_REPORTERS.has(value)) {
    throw new Error(
      `测试启动器不支持 reporter：${value}；允许值：${
        [
          ...TEST_REPORTERS,
        ].join("、")
      }`,
    );
  }
  return value;
}

/** 只允许不改变资源边界的 Deno test 诊断参数。 */
export function parseSafeTestArgs(args: readonly string[]): string[] {
  const testArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--filter") {
      const { value, nextIndex } = consumeTestOptionValue(args, index, arg);
      testArgs.push(arg, value);
      index = nextIndex;
      continue;
    }
    if (arg.startsWith("--filter=")) {
      if (arg.length === "--filter=".length) {
        throw new Error("测试启动器的 --filter 缺少值");
      }
      testArgs.push(arg);
      continue;
    }
    if (arg === "--reporter") {
      const { value, nextIndex } = consumeTestOptionValue(args, index, arg);
      testArgs.push(arg, validateReporter(value));
      index = nextIndex;
      continue;
    }
    if (arg.startsWith("--reporter=")) {
      testArgs.push(
        `--reporter=${validateReporter(arg.slice("--reporter=".length))}`,
      );
      continue;
    }
    if (
      arg === "--fail-fast" ||
      arg === "--shuffle" ||
      arg === "--trace-leaks" ||
      arg === "--hide-stacktraces" ||
      arg === "--no-clear-screen"
    ) {
      testArgs.push(arg);
      continue;
    }
    if (/^--fail-fast=\d+$/.test(arg) || /^--shuffle=\d+$/.test(arg)) {
      testArgs.push(arg);
      continue;
    }
    if (arg === "--parallel" || arg.startsWith("--parallel=")) {
      throw new Error(
        "测试启动器拒绝 --parallel：每个 child 已拥有独立数据库，" +
          "同一数据库内并发 reset 会破坏隔离",
      );
    }
    if (!arg.startsWith("-")) {
      throw new Error(`测试启动器不接受路径参数：${arg}`);
    }
    throw new Error(
      `测试启动器不允许或不识别参数：${arg}；` +
        "测试路径、权限、配置和并发均由启动器固定",
    );
  }
  return testArgs;
}

/**
 * Deno 对不存在的目录会直接失败；迁移期模块根可能尚未创建，因此在执行前
 * 只保留真实存在的目录，同时把缺失根明确打印出来。新模块测试目录一旦创建，
 * 下一次同一正式 task 会自动发现它，不能靠静默的旧 domain 列表漏跑。
 *
 * 显式 `.ts` 文件不存在时直接失败：此前把它们混在"迁移期缺失"里跳过，
 * 结果是文件名写错（如 `types_safety_test.ts` 写成 `types_safety.test.ts`）
 * 也会显示绿色。
 *
 * @throws 显式测试文件缺失，或全部路径都缺失时
 */
export async function existingTestPaths(paths: string[]): Promise<string[]> {
  const existing: string[] = [];
  const missing: string[] = [];
  const missingFiles: string[] = [];
  for (const path of paths) {
    try {
      await Deno.stat(path);
      existing.push(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        if (/\.tsx?$/.test(path)) missingFiles.push(path);
        else missing.push(path);
      } else {
        throw error;
      }
    }
  }
  if (missingFiles.length > 0) {
    throw new Error(
      `测试启动器显式引用的测试文件不存在：${
        missingFiles.join(", ")
      }；文件名写错会被当成迁移期缺失而静默少跑，必须先修正路径`,
    );
  }
  if (missing.length > 0) {
    console.warn(
      `[test-launcher] 迁移期测试目录尚未创建（已显式跳过，不代表已验收）：${
        missing.join(", ")
      }`,
    );
  }
  if (existing.length === 0) {
    throw new Error("测试启动器没有发现任何实际测试路径，拒绝假绿");
  }
  return existing;
}

/** 解析统一 CLI；未知 mode/domain、并发参数或非法 shard/jobs 参数必须失败。 */
export function parseLauncherArgs(args: string[]): LauncherOptions {
  const rest = [...args];
  const first = rest[0];
  const knownModes = new Set<LaunchMode>([
    "test",
    "domain",
    "shared",
    "parallel",
    "pg",
    "smoke",
    "perf",
    "watch",
  ]);
  const mode = (first && !first.startsWith("-") ? first : "test") as LaunchMode;
  if (first && knownModes.has(first as LaunchMode)) rest.shift();
  else if (first && !first.startsWith("-")) {
    throw new Error(`未知测试入口：${first}`);
  }

  let domain: string | undefined;
  if (mode === "domain") {
    domain = rest.shift();
    if (!domain || !resolveModuleTestTarget(domain)) {
      throw new Error(
        `必须指定有效模块或 legacy domain：${TEST_TARGET_NAMES.join("、")}`,
      );
    }
  }

  let shardCount = DEFAULT_SHARD_COUNT;
  let jobs = DEFAULT_JOB_COUNT;
  let shardsProvided = false;
  let jobsProvided = false;
  let dryRun = false;
  let profile = false;
  let runPerf = mode === "perf";
  const testArgs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--parallel" || arg.startsWith("--parallel=")) {
      throw new Error(
        "测试启动器拒绝 --parallel：每个 child 已拥有独立数据库，" +
          "同一数据库内并发 reset 会破坏隔离",
      );
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--profile") {
      profile = true;
      continue;
    }
    if (arg === "--perf") {
      runPerf = true;
      continue;
    }
    if (arg === "--shards") {
      const raw = rest[++i];
      if (raw === undefined) throw new Error("--shards 缺少数值");
      shardCount = parseShardArgs(["--shards", raw], MAX_SHARD_COUNT);
      shardsProvided = true;
      continue;
    }
    if (arg === "--jobs") {
      const raw = rest[++i];
      if (raw === undefined) throw new Error("--jobs 缺少数值");
      jobs = parseJobArgs(["--jobs", raw], MAX_JOB_COUNT);
      jobsProvided = true;
      continue;
    }
    testArgs.push(arg);
  }

  if (mode !== "parallel") {
    // 显式传入即视为配置错误：非 parallel 入口没有多个 child 可以分配。
    if (shardsProvided) {
      throw new Error("--shards 只适用于 parallel 测试入口");
    }
    if (jobsProvided) {
      throw new Error("--jobs 只适用于 parallel 测试入口");
    }
  }
  return {
    mode,
    domain,
    shardCount,
    jobs,
    dryRun,
    runPerf,
    profile,
    testArgs: parseSafeTestArgs(testArgs),
  };
}

/** 报告目录：`--profile` 的计时与分片计划都落在这里（已被 .gitignore 覆盖）。 */
export function reportDirectory(runId: string): string {
  const moduleRoot = new URL("../", import.meta.url).pathname.replace(
    /\/$/,
    "",
  );
  return `${moduleRoot}/.test-cache/performance/${runId}`;
}

/**
 * 各入口要执行的路径。
 *
 * 显式 `.ts` 条目是启动器契约：文件名写错会被 `existingTestPaths` 直接拒绝
 * （不能退化成"迁移期缺失"跳过）。`parallel` 由分片发现决定，这里返回空数组。
 */
export function pathsFor(
  options: Pick<LauncherOptions, "mode" | "domain">,
): string[] {
  switch (options.mode) {
    case "domain":
      return [
        "tests/00_migrate_test.ts",
        "tests/seed_bootstrap_admin_test.ts",
        ...testRootsForTarget(options.domain!),
      ];
    case "shared":
      return [
        "tests/00_migrate_test.ts",
        "tests/seed_bootstrap_admin_test.ts",
        "tests/shared",
        "tests/data",
        "tests/app.test.ts",
        "tests/db",
        "tests/routes",
        "tests/scripts",
        "tests/security-headers.test.ts",
        // 真实文件名是 `*_test.ts`：写成 `*.test.ts` 会被 `existingTestPaths`
        // 当成"迁移期缺失"跳过，shared 入口就会静默少跑这两个文件。
        "tests/types_safety_test.ts",
        "tests/defensive-patterns_test.ts",
        "tests/smoke.test.ts",
      ];
    case "smoke":
      return ["tests/00_migrate_test.ts", "tests/smoke.test.ts"];
    case "perf":
      return [
        "tests/00_migrate_test.ts",
        "tests/perf",
        "src/modules/read-models/search/tests/perf",
        "src/modules/education/tests/perf",
      ];
    case "test":
    case "pg":
    case "watch":
      return ["tests", ...allTargetModuleTestRoots()];
    case "parallel":
      return [];
  }
}

/**
 * 给 child 环境注入分片名。
 *
 * `--profile` 的 `NOJ_TEST_PROFILE` / `NOJ_TEST_TIMING_DIR` / `NOJ_TEST_RUN_ID`
 * 由启动器进程环境继承（见 `profileEnvironment`），这里只覆盖分片名，让每个
 * child 写自己的 `<shard>-<pid>-<rand>.jsonl`。
 */
export function applyShardEnvironment(
  env: Record<string, string>,
  shardName: string,
): Record<string, string> {
  return { ...env, NOJ_TEST_SHARD: shardName };
}

/**
 * 解析报告目录：调用方显式 `NOJ_TEST_TIMING_DIR` 优先，否则使用默认的
 * `noj-core/.test-cache/performance/<runId>`。
 *
 * `scripts/test-baseline.ts` 会为每次重复测量指定独立目录；shard-plan.json、
 * manifest.json 与 JUnit 必须写在同一目录，报告聚合才能一次读到全部产物。
 */
export function resolveReportDirectory(
  runId: string,
  baseEnvironment: Record<string, string | undefined> = Deno.env.toObject(),
): string {
  return baseEnvironment.NOJ_TEST_TIMING_DIR?.trim() || reportDirectory(runId);
}

/**
 * 计算 `--profile` 需要写入进程环境的变量（child 随后继承）。
 *
 * 约定：
 * 1. 不传 `--profile` 时返回空映射——默认不开启计时、不落盘；
 * 2. 调用方已提供 `NOJ_TEST_TIMING_DIR` / `NOJ_TEST_RUN_ID` 时保留其值
 *    （`scripts/test-baseline.ts` 会为每次重复测量指定独立目录与 runId）；
 * 3. `NOJ_TEST_SHARD=launcher` 只用于启动器自身阶段，child 由
 *    `applyShardEnvironment` 覆盖为真实分片名。
 *
 * @param options - 已解析的启动器选项
 * @param runId - 本次 run 的标识
 * @param baseEnvironment - 调用方环境（默认 `Deno.env.toObject()`）
 */
export function profileEnvironment(
  options: Pick<LauncherOptions, "profile">,
  runId: string,
  baseEnvironment: Record<string, string | undefined> = Deno.env.toObject(),
): Record<string, string> {
  if (!options.profile) return {};
  const directory = resolveReportDirectory(runId, baseEnvironment);
  return {
    NOJ_TEST_PROFILE: "1",
    NOJ_TEST_TIMING_DIR: directory,
    // 调用方指定的 runId 优先（基线的重复测量按次区分），否则使用本次 run。
    NOJ_TEST_RUN_ID: baseEnvironment.NOJ_TEST_RUN_ID?.trim() || runId,
    NOJ_TEST_SHARD: "launcher",
  };
}
