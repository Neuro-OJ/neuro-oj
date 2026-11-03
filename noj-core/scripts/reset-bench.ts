/**
 * resetDbForTest 基准采样（P3：Core reset 与种子批量写入）。
 *
 * 用途：在一次性、按启动器语义隔离的测试库上连续执行 `resetDbForTest()`，
 * 记录每次耗时分布（中位数 / P95）与各阶段计时，用于改造前后对照。脚本不读取
 * 开发 `.env`，必须显式提供 `TEST_PG_ADMIN_URL`、`TEST_REDIS_URL`、
 * `TEST_STORAGE_ROOT` 与足够强的 `JWT_SECRET`。
 *
 * 用法：
 * ```bash
 * cd noj-core
 * TEST_PG_ADMIN_URL=postgres://noj:noj@127.0.0.1:5432/postgres \
 * TEST_REDIS_URL=redis://127.0.0.1:6379/0 \
 * TEST_STORAGE_ROOT=/tmp/noj-core-test-runs \
 * JWT_SECRET=test-secret-at-least-32-characters-long \
 * deno run -A scripts/reset-bench.ts --repeat 30 --label before
 * ```
 *
 * 参数：
 * - `--repeat <n>`：正式采样次数（默认 30），不计预热。
 * - `--warmup <n>`：采样前的预热次数（默认 2），不计入统计。
 * - `--refresh-rankings`：每次 reset 都刷新榜单物化视图（默认只做普通 reset）。
 * - `--label <text>`：输出中的采样标识（如 before / after）。
 * - `--json <path>`：把结果写入文件，便于两次采样对照归档。
 * - `--no-profile`：即使显式开启也关闭阶段计时（默认开启，便于归因剩余成本）。
 *
 * 输出：一次 JSON（样本分布 + 阶段聚合），可直接粘到计划/回报里。
 */
import postgres from "postgres";
import {
  assertDatabaseIdentifier,
  createRunPlan,
  databaseUrlFor,
  readTestEnvironment,
  shardDatabaseName,
} from "./test-launcher-resources.ts";

/** 采样参数。 */
interface BenchOptions {
  repeat: number;
  warmup: number;
  label: string;
  jsonPath?: string;
  profile: boolean;
}

/** 单个样本分布。 */
interface Distribution {
  count: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  totalMs: number;
}

/** 阶段聚合（来自 test-timing JSONL）。 */
interface PhaseStat extends Distribution {
  phase: string;
  failures: number;
}

function readPositiveInt(
  args: string[],
  flag: string,
  fallback: number,
): number {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  const raw = args[index + 1];
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} 必须是正整数，收到：${raw ?? "<缺失>"}`);
  }
  return value;
}

function readString(
  args: string[],
  flag: string,
  fallback?: string,
): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} 必须带一个值`);
  return value;
}

/** 解析命令行参数；未知参数直接拒绝，避免拼错参数静默退化为默认值。 */
function parseArgs(args: string[]): BenchOptions {
  const known = new Set([
    "--repeat",
    "--warmup",
    "--refresh-rankings",
    "--label",
    "--json",
    "--no-profile",
  ]);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!known.has(arg)) {
      throw new Error(`未知参数：${arg}；可用参数见脚本头注释`);
    }
    if (
      arg === "--repeat" || arg === "--warmup" || arg === "--label" ||
      arg === "--json"
    ) {
      i += 1;
    }
  }
  return {
    repeat: readPositiveInt(args, "--repeat", 30),
    warmup: readPositiveInt(args, "--warmup", 2),
    label: readString(args, "--label", "bench")!,
    jsonPath: readString(args, "--json"),
    profile: !args.includes("--no-profile"),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 最近秩百分位：P95 表示"95% 的样本不超过该值"。 */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return sorted[index];
}

function summarize(samples: number[]): Distribution {
  if (samples.length === 0) {
    return {
      count: 0,
      meanMs: 0,
      medianMs: 0,
      p95Ms: 0,
      minMs: 0,
      maxMs: 0,
      totalMs: 0,
    };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const total = samples.reduce((sum, value) => sum + value, 0);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  return {
    count: sorted.length,
    meanMs: round(total / sorted.length),
    medianMs: round(median),
    p95Ms: round(percentile(sorted, 95)),
    minMs: round(sorted[0]),
    maxMs: round(sorted[sorted.length - 1]),
    totalMs: round(total),
  };
}

/** 读取计时目录下的 JSONL，按阶段聚合。目录不存在或为空时返回空数组。 */
async function aggregatePhases(directory: string): Promise<PhaseStat[]> {
  const byPhase = new Map<string, number[]>();
  const failures = new Map<string, number>();
  let entries: string[] = [];
  try {
    entries = [];
    for await (const entry of Deno.readDir(directory)) {
      if (entry.isFile && entry.name.endsWith(".jsonl")) {
        entries.push(`${directory}/${entry.name}`);
      }
    }
  } catch {
    return [];
  }
  for (const file of entries) {
    const text = await Deno.readTextFile(file);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as {
          phase?: string;
          durationMs?: number;
          success?: boolean;
        };
        if (typeof record.phase !== "string") continue;
        if (typeof record.durationMs !== "number" || record.durationMs <= 0) {
          continue;
        }
        const list = byPhase.get(record.phase) ?? [];
        list.push(record.durationMs);
        byPhase.set(record.phase, list);
        if (record.success === false) {
          failures.set(record.phase, (failures.get(record.phase) ?? 0) + 1);
        }
      } catch {
        // 坏行跳过：计时是诊断能力，不能让基准脚本失败。
      }
    }
  }
  return [...byPhase.entries()]
    .map(([phase, samples]) => ({
      phase,
      failures: failures.get(phase) ?? 0,
      ...summarize(samples),
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

async function main(): Promise<void> {
  const options = parseArgs(Deno.args);
  const environment = readTestEnvironment();
  const plan = createRunPlan(environment.storageRoot);
  const databaseName = shardDatabaseName(plan, "bench");
  const databaseUrl = databaseUrlFor(environment.pgAdminUrl, databaseName);
  const storageDir = `${plan.storageRoot}/bench`;
  const timingDir = `${plan.storageRoot}/timing`;
  Deno.mkdirSync(storageDir, { recursive: true });

  // 子进程语义：这些变量必须先于 tests/helpers/db.ts 的动态导入生效。
  const overrides: Record<string, string> = {
    DATABASE_URL: databaseUrl,
    REDIS_URL: environment.redisUrl,
    SUPPORT_PACKAGE_DIR: storageDir,
    STORAGE_PROVIDER: "local",
    NOJ_ENV: "test",
    JWT_SECRET: environment.jwtSecret,
    BCRYPT_SALT_ROUNDS: Deno.env.get("BCRYPT_SALT_ROUNDS") ?? "4",
    NOJ_TEST_DATABASE_OWNED: "1",
    NOJ_TEST_DATABASE_PREFIX: plan.prefix,
    NOJ_TEST_DATABASE_NAME: databaseName,
  };
  if (options.profile) {
    Object.assign(overrides, {
      NOJ_TEST_PROFILE: "1",
      NOJ_TEST_TIMING_DIR: timingDir,
      NOJ_TEST_RUN_ID: plan.runId,
      NOJ_TEST_SHARD: "reset-bench",
    });
  }
  for (const [key, value] of Object.entries(overrides)) {
    Deno.env.set(key, value);
  }

  const admin = postgres(environment.pgAdminUrl, {
    max: 1,
    onnotice: () => {},
  });
  let created = false;
  try {
    assertDatabaseIdentifier(databaseName);
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    created = true;

    const helper = await import("../tests/helpers/db.ts");
    const connection = await import("../src/shared/db/connection.ts");

    await helper.setupSchemaForTest();
    for (let i = 0; i < options.warmup; i += 1) {
      await helper.resetDbForTest();
    }

    const samples: number[] = [];
    for (let i = 0; i < options.repeat; i += 1) {
      const start = performance.now();
      await helper.resetDbForTest();
      samples.push(performance.now() - start);
    }

    const phases = options.profile ? await aggregatePhases(timingDir) : [];
    const result = {
      label: options.label,
      repeat: options.repeat,
      warmup: options.warmup,
      deno: Deno.version.deno,
      database: databaseName,
      samples: summarize(samples),
      rawSamplesMs: samples.map(round),
      phases: phases.map((phase) => ({
        ...phase,
        meanMs: phase.meanMs,
        medianMs: phase.medianMs,
        p95Ms: phase.p95Ms,
      })),
    };
    const text = JSON.stringify(result, null, 2);
    console.log(text);
    if (options.jsonPath) {
      await Deno.writeTextFile(options.jsonPath, `${text}\n`);
    }
    await connection.closeDbForShutdown();
  } finally {
    if (created) {
      await admin.unsafe(
        `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
      );
    }
    await admin.end();
    try {
      await Deno.remove(plan.storageRoot, { recursive: true });
    } catch {
      // 目录可能已被外部清理；基准脚本不因清理失败改变结果。
    }
  }
}

if (import.meta.main) {
  await main();
}
