/**
 * 测试阶段计时（P0 基础设施）。
 *
 * 目标：让"测试变慢/变快"可以被归因——是测试变少、单用例变快，还是并行度
 * 增加。启动器负责开启 profile 并给出报告目录；测试 helper、DB reset、浏览器
 * journey 通过 `measurePhase()` 记录各自阶段耗时。
 *
 * 约定：
 * 1. 默认关闭；只有启动器把 `--profile` 转成 `NOJ_TEST_PROFILE=1` 时才落盘。
 * 2. 每个测试 isolate 写自己的 JSONL 文件（文件名含 shard、PID 与随机标识），
 *    多个 Deno 测试文件即使并行也不会互相覆盖。
 * 3. 记录只允许测试标识、阶段、耗时和计数。禁止写入 token、密码、完整连接串
 *    或请求内容——这些内容不得作为 phase/tags 传入。
 * 4. 落盘失败不能让测试失败：计时是诊断能力，不是断言语义；失败后关闭写入并
 *    在 stderr 提示一次。
 */

/** 开启阶段计时的环境开关。 */
export const TEST_PROFILE_ENV = "NOJ_TEST_PROFILE";
/** 启动器提供的计时输出目录（`test-results/performance/<runId>`）。 */
export const TEST_TIMING_DIR_ENV = "NOJ_TEST_TIMING_DIR";
/** 本次运行 ID，用于报告关联。 */
export const TEST_RUN_ID_ENV = "NOJ_TEST_RUN_ID";
/** 本次分片名，用于报告关联。 */
export const TEST_SHARD_ENV = "NOJ_TEST_SHARD";

/** 单条阶段计时记录；字段刻意保持最小且可安全归档。 */
export interface TestTimingRecord {
  version: 1;
  runId: string;
  shard: string;
  phase: string;
  durationMs: number;
  success: boolean;
  file?: string;
  caseName?: string;
  count?: number;
}

/** 阶段标签：只允许测试标识，不允许凭据或请求内容。 */
export interface PhaseTags {
  /** 测试文件路径（相对仓库或模块根）。 */
  file?: string;
  /** 用例名（Deno.test 的 name）。 */
  caseName?: string;
  /** 该阶段的处理条数（如 reset 次数、探测次数）。 */
  count?: number;
}

/** 读取环境变量的最小接口，便于单元测试注入。 */
export interface EnvReader {
  get(key: string): string | undefined;
}

/** 报告目录由启动器提供；未提供时不写文件。 */
export interface TestTimingRecorderOptions {
  /** 显式开关；缺省读 `NOJ_TEST_PROFILE`。 */
  enabled?: boolean;
  /** 显式目录；缺省读 `NOJ_TEST_TIMING_DIR`。 */
  directory?: string;
  /** 运行 ID；缺省读 `NOJ_TEST_RUN_ID`，再退化为 `local-<时间戳>`。 */
  runId?: string;
  /** 分片名；缺省读 `NOJ_TEST_SHARD`，再退化为 `single`。 */
  shard?: string;
  /** 注入时钟，便于测试（默认 performance.now）。 */
  now?: () => number;
  /** 文件名后缀，仅测试使用（默认 PID + 随机标识）。 */
  fileSuffix?: string;
  /** 注入环境读取器。 */
  env?: EnvReader;
  /** 落盘实现，仅测试使用。 */
  writeLine?: (file: string, line: string) => void;
}

/** 记录入口。 */
export interface TimingRecordInput extends PhaseTags {
  phase: string;
  durationMs: number;
  success?: boolean;
}

/** 计时记录器。 */
export interface TestTimingRecorder {
  readonly enabled: boolean;
  readonly runId: string;
  readonly shard: string;
  readonly directory?: string;
  /** 计时执行一个阶段：异常经 finally 记录后原样抛出。 */
  measure<T>(
    phase: string,
    fn: () => Promise<T>,
    tags?: PhaseTags,
  ): Promise<T>;
  /** 直接记录一条（用于外部已计时的阶段）。 */
  record(record: TimingRecordInput): void;
  /** 记录一个纯计数（durationMs = 0）。 */
  count(phase: string, count: number, tags?: PhaseTags): void;
  /** 同步落盘，因此 flush 只做错误复检，保持调用方语义统一。 */
  flush(): void;
}

function envValue(env: EnvReader, key: string): string | undefined {
  const value = env.get(key)?.trim();
  return value ? value : undefined;
}

/** profile 是否开启；启动器负责把 `--profile` 转换为该变量。 */
export function isTimingProfileEnabled(env: EnvReader = Deno.env): boolean {
  return envValue(env, TEST_PROFILE_ENV) === "1";
}

/** 计时输出目录；未配置时返回 undefined（不落盘）。 */
export function resolveTimingDirectory(
  env: EnvReader = Deno.env,
): string | undefined {
  return envValue(env, TEST_TIMING_DIR_ENV);
}

function defaultWriteLine(file: string, line: string): void {
  Deno.writeTextFileSync(file, line, { append: true, create: true });
}

/**
 * 创建记录器。
 *
 * 目录在构造时创建一次；文件在第一次真正写入时才创建，未发生计时的 isolate
 * 不会留下空文件。
 */
export function createTestTimingRecorder(
  options: TestTimingRecorderOptions = {},
): TestTimingRecorder {
  const env = options.env ?? Deno.env;
  const enabled = options.enabled ?? isTimingProfileEnabled(env);
  const runId = options.runId ?? envValue(env, TEST_RUN_ID_ENV) ??
    `local-${Date.now().toString(36)}`;
  const shard = options.shard ?? envValue(env, TEST_SHARD_ENV) ?? "single";
  const directory = options.directory ?? resolveTimingDirectory(env);
  const now = options.now ?? (() => performance.now());
  const writeLine = options.writeLine ?? defaultWriteLine;

  let filePath: string | undefined;
  let writeDisabled = false;

  if (enabled && directory) {
    const suffix = options.fileSuffix ??
      `${Deno.pid}-${crypto.randomUUID().slice(0, 8)}`;
    filePath = `${directory.replace(/\/+$/, "")}/${shard}-${suffix}.jsonl`;
    try {
      Deno.mkdirSync(directory, { recursive: true });
    } catch (error) {
      writeDisabled = true;
      console.error(
        `[test-timing] 计时目录创建失败，后续阶段计时不落盘：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  function record(input: TimingRecordInput): void {
    if (!enabled || !filePath || writeDisabled) return;
    const record: TestTimingRecord = {
      version: 1,
      runId,
      shard,
      phase: input.phase,
      durationMs: Math.max(0, Math.round(input.durationMs * 100) / 100),
      success: input.success ?? true,
      ...(input.file ? { file: input.file } : {}),
      ...(input.caseName ? { caseName: input.caseName } : {}),
      ...(input.count === undefined ? {} : { count: input.count }),
    };
    try {
      writeLine(filePath, `${JSON.stringify(record)}\n`);
    } catch (error) {
      writeDisabled = true;
      console.error(
        `[test-timing] 计时写入失败，已停止本次 isolate 的计时：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    enabled: enabled && Boolean(filePath),
    runId,
    shard,
    directory: filePath ? directory : undefined,
    async measure<T>(
      phase: string,
      fn: () => Promise<T>,
      tags?: PhaseTags,
    ): Promise<T> {
      if (!enabled) return await fn();
      const start = now();
      let success = false;
      try {
        const value = await fn();
        success = true;
        return value;
      } finally {
        record({
          phase,
          durationMs: now() - start,
          success,
          ...tags,
        });
      }
    },
    record,
    count(phase: string, count: number, tags?: PhaseTags): void {
      record({ phase, durationMs: 0, success: true, count, ...tags });
    },
    flush(): void {},
  };
}

let defaultRecorder: TestTimingRecorder | undefined;

/** 进程/isolate 级默认记录器（延迟创建，未开启时不产生开销）。 */
export function getDefaultTestTimingRecorder(): TestTimingRecorder {
  defaultRecorder ??= createTestTimingRecorder();
  return defaultRecorder;
}

/** 仅测试使用：清空默认记录器，便于验证环境变量切换。 */
export function resetDefaultTestTimingRecorderForTest(): void {
  defaultRecorder = undefined;
}

/** 统一入口：测试 helper 只依赖本函数，不关心报告目录如何配置。 */
export function measurePhase<T>(
  phase: string,
  fn: () => Promise<T>,
  tags?: PhaseTags,
): Promise<T> {
  return getDefaultTestTimingRecorder().measure(phase, fn, tags);
}

/** 记录纯计数阶段（如 reset 次数、探测次数）。 */
export function countPhase(
  phase: string,
  count: number,
  tags?: PhaseTags,
): void {
  getDefaultTestTimingRecorder().count(phase, count, tags);
}
