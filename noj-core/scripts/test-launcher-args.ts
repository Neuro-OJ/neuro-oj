/**
 * 统一测试启动器的 CLI 解析。
 *
 * 这个模块只处理参数和目录选择，不读取环境、不连外部服务，便于在
 * `test:runtime` 的零依赖逻辑测试中直接验证。
 */
import { parseShardArgs } from "./test-parallel-args.ts";
import { SHARDS } from "./test-parallel-shards.ts";
import {
  LEGACY_DOMAIN_NAMES,
  resolveModuleTestTarget,
  TARGET_MODULE_NAMES,
} from "../../scripts/module-test-metadata.ts";

export type LaunchMode =
  | "test"
  | "domain"
  | "shared"
  | "parallel"
  | "pg"
  | "smoke"
  | "perf"
  | "watch";

export interface LauncherOptions {
  mode: LaunchMode;
  domain?: string;
  shardCount: number;
  dryRun: boolean;
  runPerf: boolean;
  testArgs: string[];
}

export const TEST_TARGET_NAMES = [
  ...TARGET_MODULE_NAMES,
  ...LEGACY_DOMAIN_NAMES,
] as const;

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
 * 只保留真实存在的路径，同时把缺失根明确打印出来。新模块测试目录一旦创建，
 * 下一次同一正式 task 会自动发现它，不能靠静默的旧 domain 列表漏跑。
 */
export async function existingTestPaths(paths: string[]): Promise<string[]> {
  const existing: string[] = [];
  const missing: string[] = [];
  for (const path of paths) {
    try {
      await Deno.stat(path);
      existing.push(path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) missing.push(path);
      else throw error;
    }
  }
  if (missing.length > 0) {
    console.warn(
      `[test-launcher] 迁移期测试根尚未创建（已显式跳过，不代表已验收）：${
        missing.join(", ")
      }`,
    );
  }
  if (existing.length === 0) {
    throw new Error("测试启动器没有发现任何实际测试路径，拒绝假绿");
  }
  return existing;
}

/** 解析统一 CLI；未知 mode/domain、并发参数或非法 shard 参数必须失败。 */
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

  let shardCount = SHARDS.length;
  let dryRun = false;
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
    if (arg === "--perf") {
      runPerf = true;
      continue;
    }
    if (arg === "--shards") {
      const raw = rest[++i];
      if (raw === undefined) throw new Error("--shards 缺少数值");
      shardCount = parseShardArgs(["--shards", raw], SHARDS.length);
      continue;
    }
    testArgs.push(arg);
  }

  if (mode !== "parallel" && shardCount !== SHARDS.length) {
    throw new Error("--shards 只适用于 parallel 测试入口");
  }
  return {
    mode,
    domain,
    shardCount,
    dryRun,
    runPerf,
    testArgs: parseSafeTestArgs(testArgs),
  };
}
