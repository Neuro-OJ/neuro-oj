/**
 * 排空后解除 Judge 资源组容量配置锁，并可选调整并发与重建容器。
 *
 * 与 `noj-judge/src/scheduling.rs::Scheduler::reset_group_config` 保持同一
 * 原子语义：只有当资源组租约哈希与 RSS 心跳哈希中的所有条目均已过期后，
 * 才原子删除资源组下的全部 Redis 键，防止在途 Worker 未排空时产生容量脑裂。
 *
 * 本模块不持有模块级可变状态（AGENTS.md §6.2 多副本约束）。
 */

import { parseDocument } from "yaml";
import { serializeEnvFile } from "../../core/env-file.ts";
import { UsageError } from "../../util/args.ts";
import { prepareExisting, runCompose } from "./actions.ts";
import type { JudgeActionOptions, JudgeActionResult } from "./actions.ts";
import { judgeComposeArgs } from "./compose.ts";
import {
  assertJudgeConfigValues,
  JUDGE_COMPOSE_MODE,
  JUDGE_ENV_MODE,
} from "./config.ts";
import { evalRedisScriptStrict, type RedisEvalOutcome } from "./redis-resp.ts";
import {
  computeJudgeStopTimeoutSeconds,
  hasJudgeComposeEnvFile,
  type ParsedRedisConnection,
  parseResolvedComposeEnv,
  patchJudgeComposeEnvironment,
  readJudgeComposeEnv,
  resolveHostRedisConnection,
  stageFileAtomic,
} from "./reset-config-helpers.ts";

/** 资源组名称与前缀允许的字符规则（与 Rust `Settings::from_env` 对齐）。 */
const IDENT_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** 默认排空等待上限（秒）；Heartbeat TTL 为 30s，Lease TTL 为 60s。 */
export const DEFAULT_RESET_WAIT_TIMEOUT_SECONDS = 90;

/** 默认轮询间隔（毫秒）。 */
const DEFAULT_POLL_INTERVAL_MS = 3000;

/** 单次 Redis / Compose 命令的默认超时上限（毫秒）。 */
const DEFAULT_REDIS_CMD_TIMEOUT_MS = 15_000;

/**
 * 与 `noj-judge/src/scheduling.rs::Scheduler::reset_group_config` 等价的单行 Lua 脚本。
 */
export const JUDGE_RESET_LUA =
  "local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000); " +
  "for _,k in ipairs({KEYS[1],KEYS[2]}) do " +
  "local entries=redis.call('HGETALL',k); " +
  "for i=1,#entries,2 do " +
  "local ok,item=pcall(cjson.decode,entries[i+1]); " +
  "if not ok or not item.expires or item.expires>now then return 0 end " +
  "end end; " +
  "redis.call('DEL',KEYS[1],KEYS[2],KEYS[3],KEYS[4],KEYS[5],KEYS[6],KEYS[7]); return 1";

/** 允许通过 `reset-config` 就地更新的调度配置键白名单。 */
export const JUDGE_RESET_UPDATE_KEYS = [
  "JUDGE_AI_TASK_CONCURRENCY",
  "JUDGE_WASM_TASK_CONCURRENCY",
  "JUDGE_NATIVE_TASK_CONCURRENCY",
  "JUDGE_WASM_COMPILE_CONCURRENCY",
  "JUDGE_WASM_CASE_CONCURRENCY",
  "JUDGE_RESOURCE_MEMORY_MB",
  "JUDGE_RESOURCE_POOLS",
] as const;

const ALLOWED_UPDATE_SET: ReadonlySet<string> = new Set(
  JUDGE_RESET_UPDATE_KEYS,
);

/** `judge reset-config` 的输入选项。 */
export interface JudgeResetConfigOptions extends JudgeActionOptions {
  /** 覆盖资源组名（缺省读生效配置中的 `JUDGE_RESOURCE_GROUP`）。 */
  group?: string;
  /** 覆盖 claim/资源前缀（缺省读生效配置中的 `JUDGE_USER_CLAIM_PREFIX` 或从 `JUDGE_QUEUE` 派生）。 */
  claimPrefix?: string;
  /** 执行前是否先停止本机 Judge 容器（`compose stop -t <sec>`）。 */
  stop?: boolean;
  /** 是否先停止本机 Judge、重置并更新后以 `--force-recreate` 重建启动。 */
  restart?: boolean;
  /** 等待同组其他心跳/租约过期的最长秒数（0..3600，默认 90）。 */
  waitTimeoutSeconds?: number;
  /** 轮询间隔（毫秒，默认 3000；测试可注入 0）。 */
  pollIntervalMs?: number;
  /** 单次 Redis / Compose 命令超时上限（毫秒，默认 15000；测试可注入）。 */
  commandTimeoutMs?: number;
  /** 休眠实现（测试注入）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 待更新的调度配置键值对（只允许 {@link JUDGE_RESET_UPDATE_KEYS}）。 */
  updates?: Record<string, string>;
  /** Redis 严格脚本执行实现（测试注入；缺省使用纯 Deno RESP2 客户端）。 */
  evalRedis?: (
    conn: ParsedRedisConnection,
    lua: string,
    keys: readonly string[],
    timeoutMs: number,
  ) => Promise<RedisEvalOutcome>;
  /** 宿主环境变量表（用于 `--dry-run` 静态展开测试注入；缺省读 `Deno.env.toObject()`）。 */
  hostEnv?: Record<string, string>;
  /** 文件原子替换实现（用于测试模拟第二阶段提交失败与自动回滚；缺省 `Deno.rename`）。 */
  commitFile?: (stagedPath: string, destPath: string) => Promise<void>;
}

/** `judge reset-config` 的执行结果。 */
export interface JudgeResetConfigResult extends JudgeActionResult {
  resourceGroup: string;
  claimPrefix: string;
  updatedKeys: string[];
  cleared: boolean;
  restarted: boolean;
}

/**
 * 推导 Judge 的 claim/资源前缀，规则与 `noj-judge/src/config.rs` 一致：
 * `override` → `JUDGE_USER_CLAIM_PREFIX` → `JUDGE_QUEUE` 去掉末段 `:<tail>`。
 */
export function deriveJudgeClaimPrefix(
  env: Record<string, string>,
  override?: string,
): string {
  if (override !== undefined && override.trim() === "") {
    throw new UsageError("--claim-prefix 不能为空");
  }
  const explicit = override?.trim();
  const fromEnv = (env["JUDGE_USER_CLAIM_PREFIX"] ?? "").trim();
  let prefix: string;
  if (explicit) {
    prefix = explicit;
  } else if (fromEnv) {
    prefix = fromEnv;
  } else {
    const queue = (env["JUDGE_QUEUE"] ?? "").trim() || "noj:judge:queue";
    const lastColon = queue.lastIndexOf(":");
    prefix = lastColon >= 0 ? queue.slice(0, lastColon) : queue;
  }
  if (!IDENT_PATTERN.test(prefix)) {
    throw new UsageError(
      `claim 前缀非法：${prefix}（仅允许字母、数字、_.:-，长度 1..128）`,
    );
  }
  return prefix;
}

/** 解析目标资源组名（`--group` 优先于生效配置中的 `JUDGE_RESOURCE_GROUP`）。 */
export function resolveJudgeResourceGroup(
  env: Record<string, string>,
  override?: string,
): string {
  if (override !== undefined && override.trim() === "") {
    throw new UsageError("--group 不能为空");
  }
  const group = (override ?? env["JUDGE_RESOURCE_GROUP"] ?? "").trim();
  if (group === "") {
    throw new UsageError(
      "未配置 JUDGE_RESOURCE_GROUP，请通过 --group <资源组名> 显式指定" +
        "（未显式配置时 Worker 默认使用容器内派生的 JUDGE_INSTANCE_ID）",
    );
  }
  if (!IDENT_PATTERN.test(group)) {
    throw new UsageError(`资源组名非法：${group}`);
  }
  return group;
}

/** 返回某个资源组在 Redis 中需要原子清理的 7 个键。 */
export function resourceGroupKeys(
  claimPrefix: string,
  group: string,
): readonly string[] {
  const base = `${claimPrefix}:resources:${group}`;
  return [
    base,
    `${base}:rss`,
    `${base}:config`,
    `${base}:requests`,
    `${base}:turns`,
    `${base}:turn-sequence`,
    `${base}:sequence`,
  ] as const;
}

function validateWaitTimeout(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) {
    throw new UsageError(
      `--wait-timeout 必须为 0～3600 的整数，收到 "${seconds}"`,
    );
  }
  return seconds;
}

function validateUpdates(
  raw: Record<string, string> | undefined,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!ALLOWED_UPDATE_SET.has(key)) {
      throw new UsageError(`不允许通过 reset-config 修改配置键：${key}`);
    }
    if (/[\r\n\0]/.test(value)) {
      throw new UsageError(`配置键 ${key} 不得包含换行或控制字符`);
    }
    if (key === "JUDGE_RESOURCE_POOLS") {
      clean[key] = value.split(",").map((p) => p.trim()).join(",");
    } else {
      clean[key] = value.trim();
    }
  }
  return clean;
}

async function runWithBudget(
  runPromise: Promise<{ code: number; stdout: string; stderr: string }>,
  timeoutMs: number,
): Promise<{ code: number; stdout: string; timedOut: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race([
      runPromise.then((res) => ({
        kind: "done" as const,
        code: res.code,
        stdout: res.stdout,
      })),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]);
    if (raced.kind === "timeout") {
      return { code: 124, stdout: "", timedOut: true };
    }
    return {
      code: raced.code,
      stdout: raced.stdout,
      timedOut: raced.code === 124,
    };
  } catch {
    return { code: 1, stdout: "", timedOut: false };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 排空后解除资源组容量配置锁，并按需写入新并发配置与局部更新重建容器。
 *
 * 完整防线：参数与调度校验、共享 socket 守卫、权威 Compose 环境解析、
 * Redis URL 一致性校验、双配置文件预暂存均发生在停机与写 Redis 之前。
 */
export async function judgeResetConfig(
  opts: JudgeResetConfigOptions,
): Promise<JudgeResetConfigResult> {
  const log = opts.log ?? (() => {});
  const prepared = await prepareExisting(opts);
  if (!prepared.ok) {
    return {
      ...prepared.result,
      resourceGroup: "",
      claimPrefix: "",
      updatedKeys: [],
      cleared: false,
      restarted: false,
    };
  }
  const { paths, env } = prepared;
  const maxAttemptMs = opts.commandTimeoutMs ?? DEFAULT_REDIS_CMD_TIMEOUT_MS;

  let waitTimeoutSeconds: number;
  let updates: Record<string, string>;
  let updatedKeys: string[];
  let envText: string;
  let originalEnvMode: number;
  let composeText: string;
  let patchedCompose: string | null = null;
  let nextEnvText: string | null = null;

  try {
    envText = await Deno.readTextFile(paths.envFile);
    const envStat = await Deno.stat(paths.envFile);
    originalEnvMode = (envStat.mode ?? JUDGE_ENV_MODE) & 0o777;
    composeText = await Deno.readTextFile(paths.composeFile);

    waitTimeoutSeconds = validateWaitTimeout(
      opts.waitTimeoutSeconds ?? DEFAULT_RESET_WAIT_TIMEOUT_SECONDS,
    );
    updates = validateUpdates(opts.updates);
    updatedKeys = Object.keys(updates);
    assertJudgeConfigValues({ ...env, ...updates });

    if (updatedKeys.length > 0) {
      patchedCompose = patchJudgeComposeEnvironment(composeText, updates);
      const patchedDoc = parseDocument(patchedCompose);
      if (patchedDoc.errors.length > 0) {
        throw new Error(
          `局部更新后的 Compose YAML 无效：${patchedDoc.errors[0]!.message}`,
        );
      }
      nextEnvText = serializeEnvFile(
        new Map(Object.entries(updates)),
        envText,
      );
    }
  } catch (err) {
    return {
      exitCode: err instanceof UsageError ? 2 : 1,
      message: (err as Error).message,
      paths,
      resourceGroup: "",
      claimPrefix: "",
      updatedKeys: [],
      cleared: false,
      restarted: false,
    };
  }

  let effectiveEnv: Record<string, string>;
  if (opts.dryRun === true) {
    try {
      if (hasJudgeComposeEnvFile(composeText)) {
        throw new UsageError(
          "Compose 使用了外部 env_file，--dry-run 无法静态展开实际环境变量；请去掉 --dry-run 执行",
        );
      }
      const hostEnv = opts.hostEnv ?? Deno.env.toObject();
      const staticEnv = readJudgeComposeEnv(composeText, env, hostEnv);
      if (staticEnv === null) {
        throw new UsageError(
          "Compose 配置缺少 services.judge.environment 或 YAML 无效，无法确定 Worker 实际环境配置",
        );
      }
      effectiveEnv = staticEnv;
    } catch (err) {
      return {
        exitCode: err instanceof UsageError ? 2 : 1,
        message: (err as Error).message,
        paths,
        resourceGroup: "",
        claimPrefix: "",
        updatedKeys: [],
        cleared: false,
        restarted: false,
      };
    }
  } else {
    const dockerBin = opts.dockerBin ?? "docker";
    const configRes = await runWithBudget(
      opts.runner.run(dockerBin, judgeComposeArgs(paths, ["config"]), {
        timeoutMs: maxAttemptMs,
      }),
      maxAttemptMs,
    );
    if (configRes.timedOut || configRes.code !== 0) {
      return {
        exitCode: 1,
        message: configRes.timedOut
          ? "解析 Judge Compose 配置超时，已中止（未停机且未修改 Redis）"
          : "解析 Judge Compose 实际配置失败，请检查 Compose 文件与环境变量（未停机且未修改 Redis）",
        paths,
        resourceGroup: "",
        claimPrefix: "",
        updatedKeys: [],
        cleared: false,
        restarted: false,
      };
    }
    try {
      effectiveEnv = parseResolvedComposeEnv(configRes.stdout);
    } catch (err) {
      return {
        exitCode: 1,
        message: `${(err as Error).message}（未停机且未修改 Redis）`,
        paths,
        resourceGroup: "",
        claimPrefix: "",
        updatedKeys: [],
        cleared: false,
        restarted: false,
      };
    }
  }

  let claimPrefix: string;
  let resourceGroup: string;
  let redisConn: ParsedRedisConnection;
  let stopTimeoutSeconds: number;
  try {
    claimPrefix = deriveJudgeClaimPrefix(effectiveEnv, opts.claimPrefix);
    resourceGroup = resolveJudgeResourceGroup(effectiveEnv, opts.group);
    // Compose 实际解析出的 REDIS_URL 是 Worker 实连地址；REDIS_CHECK_URL 来自 .env.judge（宿主机）。
    redisConn = resolveHostRedisConnection({
      REDIS_URL: effectiveEnv["REDIS_URL"] ?? "",
      REDIS_CHECK_URL: env["REDIS_CHECK_URL"] ?? "",
    });
    stopTimeoutSeconds = computeJudgeStopTimeoutSeconds(effectiveEnv);
  } catch (err) {
    return {
      exitCode: err instanceof UsageError ? 2 : 1,
      message: (err as Error).message,
      paths,
      resourceGroup: "",
      claimPrefix: "",
      updatedKeys: [],
      cleared: false,
      restarted: false,
    };
  }

  const warnIgnoredEnvPrefix = opts.claimPrefix === undefined &&
    (env["JUDGE_USER_CLAIM_PREFIX"] ?? "").trim() !== "" &&
    (effectiveEnv["JUDGE_USER_CLAIM_PREFIX"] ?? "").trim() === "";
  if (warnIgnoredEnvPrefix) {
    log(
      `! 注意：.env.judge 配置了 JUDGE_USER_CLAIM_PREFIX，但当前 Compose 未注入该变量；` +
        `将按 Worker 实际生效的前缀 ${claimPrefix} 重置`,
    );
  }

  const shouldStop = opts.stop === true || opts.restart === true;

  if (opts.dryRun === true) {
    if (shouldStop) {
      log(
        `[dry-run] 将先停止本机 Judge 容器（compose stop -t ${stopTimeoutSeconds}）`,
      );
    }
    log(
      `[dry-run] 将重置 Redis 资源组配置锁：组=${resourceGroup}，前缀=${claimPrefix}（目标 ${redisConn.host}:${redisConn.port} DB ${redisConn.db}，清理 7 个资源组键，等待超时 ${waitTimeoutSeconds}s）`,
    );
    if (updatedKeys.length > 0) {
      const pairs = updatedKeys.map((k) => `${k}=${updates[k]}`).join(", ");
      log(`[dry-run] 将更新配置 ${paths.envFile}：${pairs}`);
      log(`[dry-run] 将局部更新 Compose 调度字段：${paths.composeFile}`);
    }
    if (opts.restart === true) {
      log(
        "[dry-run] 将重建并启动 Judge 容器（compose up -d --force-recreate）",
      );
    }
    return {
      exitCode: 0,
      message: "[dry-run] 资源组重置流程校验通过，未做任何修改",
      paths,
      resourceGroup,
      claimPrefix,
      updatedKeys,
      cleared: false,
      restarted: false,
    };
  }

  let stagedEnvPath: string | null = null;
  let stagedComposePath: string | null = null;
  const commitFile = opts.commitFile ?? Deno.rename;

  try {
    // 在停机或删除 Redis 锁之前先完成双配置文件预暂存与可写性验证。
    if (
      updatedKeys.length > 0 && patchedCompose !== null && nextEnvText !== null
    ) {
      try {
        stagedEnvPath = await stageFileAtomic(
          paths.envFile,
          nextEnvText,
          JUDGE_ENV_MODE,
          ".env.judge",
        );
        stagedComposePath = await stageFileAtomic(
          paths.composeFile,
          patchedCompose,
          JUDGE_COMPOSE_MODE,
          "docker-compose.judge.yml",
        );
      } catch (err) {
        return {
          exitCode: 1,
          message: `预暂存配置文件失败（未停机且未修改 Redis）：${
            (err as Error).message
          }`,
          paths,
          resourceGroup,
          claimPrefix,
          updatedKeys: [],
          cleared: false,
          restarted: false,
        };
      }
    }

    if (shouldStop) {
      const stopCode = await runCompose(opts, paths, [
        "stop",
        "-t",
        String(stopTimeoutSeconds),
      ]);
      if (stopCode !== 0) {
        return {
          exitCode: 1,
          message: "停止 Judge 失败，已中止重置资源组配置锁",
          paths,
          resourceGroup,
          claimPrefix,
          updatedKeys: [],
          cleared: false,
          restarted: false,
        };
      }
      log("✓ 本机 Judge 容器已停止（配置、缓存与 Redis 任务均已保留）");
    }

    const keys = resourceGroupKeys(claimPrefix, resourceGroup);
    const now = opts.now ?? (() => new Date());
    const deadlineMs = now().getTime() + waitTimeoutSeconds * 1000;
    const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const sleep = opts.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const evalRedis = opts.evalRedis ?? evalRedisScriptStrict;

    while (true) {
      const remainingForAttempt = deadlineMs - now().getTime();
      const attemptTimeoutMs = waitTimeoutSeconds === 0
        ? maxAttemptMs
        : Math.max(1, Math.min(maxAttemptMs, remainingForAttempt));
      const res = await evalRedis(
        redisConn,
        JUDGE_RESET_LUA,
        keys,
        attemptTimeoutMs,
      );
      if (!res.ok) {
        return {
          exitCode: 1,
          message: res.message,
          paths,
          resourceGroup,
          claimPrefix,
          updatedKeys: [],
          cleared: false,
          restarted: false,
        };
      }
      if (res.cleared) {
        break;
      }
      const remainingMs = deadlineMs - now().getTime();
      if (remainingMs <= 0) {
        return {
          exitCode: 1,
          message:
            `资源组 ${resourceGroup} 仍有有效 Worker 心跳或执行租约；请先停止同组所有 Worker（含多节点）并等待排空后重试`,
          paths,
          resourceGroup,
          claimPrefix,
          updatedKeys: [],
          cleared: false,
          restarted: false,
        };
      }
      log(`… 资源组 ${resourceGroup} 仍有有效心跳或租约，等待排空后重试`);
      await sleep(Math.max(0, Math.min(pollIntervalMs, remainingMs)));
    }

    log(`✓ 已解除资源组配置锁：${claimPrefix}:resources:${resourceGroup}`);

    if (
      updatedKeys.length > 0 &&
      stagedEnvPath !== null &&
      stagedComposePath !== null
    ) {
      try {
        await commitFile(stagedEnvPath, paths.envFile);
        stagedEnvPath = null;
      } catch (err) {
        return {
          exitCode: 1,
          message:
            `资源组配置锁已解除，但提交 ${paths.envFile} 失败（原配置文件均未被修改；重启后将按原并发重新建锁）：${
              (err as Error).message
            }`,
          paths,
          resourceGroup,
          claimPrefix,
          updatedKeys: [],
          cleared: true,
          restarted: false,
        };
      }
      log(`✓ 已更新配置 ${paths.envFile}：${updatedKeys.join(", ")}`);

      try {
        await commitFile(stagedComposePath, paths.composeFile);
        stagedComposePath = null;
      } catch (err) {
        let rollbackNote: string;
        try {
          const rollbackEnvPath = await stageFileAtomic(
            paths.envFile,
            envText,
            originalEnvMode,
            ".env.judge（回滚）",
          );
          try {
            await commitFile(rollbackEnvPath, paths.envFile);
          } catch (rollbackCommitErr) {
            await Deno.remove(rollbackEnvPath).catch(() => {});
            throw rollbackCommitErr;
          }
          rollbackNote =
            `已自动回滚 ${paths.envFile} 至原配置，两个文件保持一致`;
        } catch (rollbackErr) {
          rollbackNote = `自动回滚 ${paths.envFile} 失败（${
            (rollbackErr as Error).message
          }），请人工检查并恢复 ${paths.envFile}`;
        }
        return {
          exitCode: 1,
          message: `资源组配置锁已解除，但提交 Compose 配置失败（${
            (err as Error).message
          }）；${rollbackNote}`,
          paths,
          resourceGroup,
          claimPrefix,
          updatedKeys: [],
          cleared: true,
          restarted: false,
        };
      }
      log(`✓ 已局部更新 Compose 调度字段：${paths.composeFile}`);
    }

    if (opts.restart === true) {
      const upCode = await runCompose(opts, paths, [
        "up",
        "-d",
        "--force-recreate",
      ]);
      if (upCode !== 0) {
        return {
          exitCode: 1,
          message: `资源组配置锁已解除${
            updatedKeys.length > 0 ? "且配置已更新" : ""
          }，但重启 Judge 失败；请检查状态后执行 noj-cli judge start`,
          paths,
          resourceGroup,
          claimPrefix,
          updatedKeys,
          cleared: true,
          restarted: false,
        };
      }
      log("✓ Judge 已按当前 Compose 重建启动");
    }

    return {
      exitCode: 0,
      message: opts.restart === true
        ? `资源组 ${resourceGroup} 配置锁已解除并已重建启动 Judge`
        : `资源组 ${resourceGroup} 配置锁已解除`,
      paths,
      resourceGroup,
      claimPrefix,
      updatedKeys,
      cleared: true,
      restarted: opts.restart === true,
    };
  } finally {
    if (stagedEnvPath !== null) {
      await Deno.remove(stagedEnvPath).catch(() => {});
    }
    if (stagedComposePath !== null) {
      await Deno.remove(stagedComposePath).catch(() => {});
    }
  }
}
