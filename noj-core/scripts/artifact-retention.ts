/**
 * 提交产物分层保留治理 CLI（默认 --dry-run 只读预演，显式 --apply 才执行清理）。
 *
 * 用法：
 *   deno task storage:retention -- --pretty
 *   deno task storage:retention -- --apply --batch 100 --non-best-days 14 --best-days 0 --pretty
 */
import { initSystemSettings } from "../src/modules/platform/system/index.ts";
import {
  DEFAULT_CONTEST_GRACE_DAYS,
  pruneExpiredSubmissionArtifacts,
  resolveArtifactRetentionPolicyFromEnv,
} from "../src/features/artifact-retention/index.ts";

interface CliOptions {
  apply: boolean;
  batchSize: number;
  pretty: boolean;
  nonBestDays?: number;
  bestDays?: number;
}

function parseNonNegativeInt(flag: string, value: string | undefined): number {
  if (!value) throw new Error(`${flag} 需要整数参数`);
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${flag} 必须是非负整数，实际: ${value}`);
  }
  return n;
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    apply: false,
    batchSize: 100,
    pretty: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      options.apply = false;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--pretty") {
      options.pretty = true;
    } else if (arg === "--batch") {
      options.batchSize = Math.max(1, parseNonNegativeInt(arg, args[++i]));
    } else if (arg === "--non-best-days") {
      options.nonBestDays = parseNonNegativeInt(arg, args[++i]);
    } else if (arg === "--best-days") {
      options.bestDays = parseNonNegativeInt(arg, args[++i]);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return options;
}

const options = parseArgs(Deno.args);
await initSystemSettings();
const basePolicy = resolveArtifactRetentionPolicyFromEnv();
const policy = {
  ...basePolicy,
  // 运维显式执行 CLI 时按启用态评估（dry-run 仍只读零修改）
  enabled: true,
  nonBestRetentionDays: options.nonBestDays ?? basePolicy.nonBestRetentionDays,
  bestRetentionDays: options.bestDays ?? basePolicy.bestRetentionDays,
  contestGraceDays: DEFAULT_CONTEST_GRACE_DAYS,
};

const summary = await pruneExpiredSubmissionArtifacts({
  policy,
  batchSize: options.batchSize,
  dryRun: !options.apply,
});

const output = JSON.stringify(summary, null, options.pretty ? 2 : undefined) +
  "\n";
await Deno.stdout.write(new TextEncoder().encode(output));
