// config-usage: exempt-file 一次性 v0.10.6 -> v0.11 数据库逻辑升级 CLI 的临时参数回退，不属于常驻服务配置面。
/**
 * `v0.10.6 → v0.11` 逻辑数据库升级 CLI。
 *
 * 用法（连接串只经环境变量传入，避免 `deno task` 回显参数或进程列表泄露口令）：
 *   NOJ_UPGRADE_SOURCE_URL=... NOJ_UPGRADE_TARGET_URL=... \
 *     deno task db:upgrade-v010 --dry-run --json
 *
 * 注意：绝不在 stdout / stderr / 错误消息中回显任何数据库连接串或口令。
 */

import { parseArgs } from "node:util";
import {
  type PrivateProblemPolicy,
  type RestrictedContestPolicy,
  runUpgradeFromV010,
  type UpgradeReport,
  UpgradeV010Error,
} from "./upgrade-v010/index.ts";

export interface UpgradeCliOptions {
  sourceUrl?: string;
  targetUrl?: string;
  gatewayUrl?: string;
  privateProblems?: PrivateProblemPolicy;
  restrictedContests?: RestrictedContestPolicy;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

const USAGE_TEXT = [
  "Neuro OJ v0.10.6 → v0.11 逻辑数据库升级工具",
  "",
  "用法（推荐通过环境变量传连接串，避免口令出现在命令行与日志）:",
  "  NOJ_UPGRADE_SOURCE_URL=... NOJ_UPGRADE_TARGET_URL=... noj db upgrade-v010 [--dry-run] [--json]",
  "",
  "环境变量:",
  "  NOJ_UPGRADE_SOURCE_URL   只读源库（v0.10.6 / 0115）连接串",
  "  NOJ_UPGRADE_TARGET_URL   全新空目标库（只执行过 v0.11 schema 迁移）连接串",
  "  NOJ_UPGRADE_GATEWAY_URL  独立部署的 Gateway 库连接串（Gateway 不与 Core 同库时必填）",
  "",
  "参数:",
  "  --source-url / --target-url / --gateway-url <url>  同上（会出现在进程列表，不推荐）",
  "  --private-problems <disable|expose>  已发布私有题处置：disable=禁用绑定待复核，expose=接受公开",
  "  --restricted-contests <expose>       非公开/邀请/口令比赛处置：expose=接受在 main 域公开",
  "  --dry-run           仅执行只读预检、映射与规划统计，不写入目标库",
  "  --json              输出单个 JSON 文档（自动化脚本与运维编排用）",
  "  -h, --help          显示帮助并退出",
].join("\n");

/** 校验访问边界处置参数取值。 */
export function parsePrivateProblemPolicy(
  value: string | undefined,
): PrivateProblemPolicy | undefined {
  if (value === undefined) return undefined;
  if (value === "disable" || value === "expose") return value;
  throw new UpgradeV010Error(
    "INVALID_OPTIONS",
    `--private-problems 仅支持 disable 或 expose，收到: ${value}`,
  );
}

/** 校验受限比赛处置参数取值。 */
export function parseRestrictedContestPolicy(
  value: string | undefined,
): RestrictedContestPolicy | undefined {
  if (value === undefined) return undefined;
  if (value === "expose") return value;
  throw new UpgradeV010Error(
    "INVALID_OPTIONS",
    `--restricted-contests 仅支持 expose，收到: ${value}`,
  );
}

/** 解析命令行参数与环境变量回退，不访问数据库。 */
export function parseUpgradeCliArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = Deno.env.toObject(),
): UpgradeCliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "source-url": { type: "string" },
      "target-url": { type: "string" },
      "gateway-url": { type: "string" },
      "private-problems": { type: "string" },
      "restricted-contests": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
    allowPositionals: false,
  });

  const sourceUrl = values["source-url"]?.trim() ||
    env.NOJ_UPGRADE_SOURCE_URL?.trim() ||
    undefined;
  const targetUrl = values["target-url"]?.trim() ||
    env.NOJ_UPGRADE_TARGET_URL?.trim() ||
    undefined;
  const gatewayUrl = values["gateway-url"]?.trim() ||
    env.NOJ_UPGRADE_GATEWAY_URL?.trim() ||
    undefined;

  return {
    sourceUrl,
    targetUrl,
    gatewayUrl,
    privateProblems: parsePrivateProblemPolicy(values["private-problems"]),
    restrictedContests: parseRestrictedContestPolicy(
      values["restricted-contests"],
    ),
    dryRun: Boolean(values["dry-run"]),
    json: Boolean(values.json),
    help: Boolean(values.help),
  };
}

/** 格式化人类可读升级报告摘要（严格不含凭据与 URL）。 */
export function formatUpgradeReport(report: UpgradeReport): string {
  const modeLabel = report.dryRun
    ? "DRY-RUN 预演完成（未写入目标库）"
    : "升级迁移提交完成";
  const nonZeroTables = Object.entries(report.tableCounts)
    .filter(([, count]) => count > 0)
    .map(([table, count]) => `  - ${table}: ${count}`)
    .join("\n");

  const lines = [
    `=== ${modeLabel} ===`,
    `执行时间: ${report.executedAt}`,
    `默认空间: ${report.defaultDomainSlug} (${report.defaultDomainId})，owner_id=${report.defaultDomainOwnerId}`,
    `迁移账本: 源库 ${report.sourceMigrationCount} 条 → 目标库 ${report.targetMigrationCount} 条`,
    `U 题重编号: ${report.archivedSummary.renumberedProblems.length} 道`,
    `跳过动态帖 (moment): ${report.archivedSummary.skippedMomentPosts.length} 篇（级联评论 ${report.archivedSummary.skippedMomentComments} 条）`,
    `跳过私信举报/搜索/动态举报: ${report.archivedSummary.skippedMessageReports}/${report.archivedSummary.skippedMessageSearchEntries}/${report.archivedSummary.skippedMomentReports}`,
    `跳过已下线审计动作: ${report.archivedSummary.skippedAuditLogs} 条；清理废弃设置键: ${report.archivedSummary.droppedSystemSettings.length} 个`,
    `Gateway 同库迁移: ${
      report.gateway.detected
        ? `providers=${report.gateway.copiedProviders}, usage=${report.gateway.copiedUsage}, quotas=${report.gateway.copiedQuotas}, domainSettings=${report.gateway.backfilledDomainSettings}, aliases=${report.gateway.backfilledModelAliases}`
        : "未检测到同库 Gateway 表（已跳过）"
    }`,
    `独立 Gateway 模型配置: ${
      report.gateway.standalone
        ? `domainSettings=${report.gateway.standalone.domainSettings}, aliases=${report.gateway.standalone.modelAliases}, verified=${report.gateway.standalone.verified}`
        : "无需转移"
    }`,
    `私有题处置: ${report.archivedSummary.privateProblems.length} 道；受限比赛处置: ${report.archivedSummary.restrictedContests.length} 场；孤儿批量任务条目: ${report.archivedSummary.orphanJobItems.length} 条`,
  ];
  if (nonZeroTables) {
    lines.push("已迁移/生成行数（非空表）:", nonZeroTables);
  }
  return lines.join("\n");
}

/** 运行 CLI 升级并返回退出码（0=成功，1=失败）。 */
export async function executeUpgradeCli(
  options: Partial<
    & Pick<
      UpgradeCliOptions,
      "sourceUrl" | "targetUrl" | "gatewayUrl" | "dryRun" | "json"
    >
    & { privateProblems: string; restrictedContests: string }
  >,
  env: Record<string, string | undefined> = Deno.env.toObject(),
): Promise<number> {
  const sourceUrl = options.sourceUrl?.trim() ||
    env.NOJ_UPGRADE_SOURCE_URL?.trim() || "";
  const targetUrl = options.targetUrl?.trim() ||
    env.NOJ_UPGRADE_TARGET_URL?.trim() || "";
  const gatewayUrl = options.gatewayUrl?.trim() ||
    env.NOJ_UPGRADE_GATEWAY_URL?.trim() || undefined;

  if (!sourceUrl || !targetUrl) {
    const errPayload = {
      ok: false,
      code: "INVALID_OPTIONS",
      message:
        "必须同时提供 --source-url（或 NOJ_UPGRADE_SOURCE_URL）与 --target-url（或 NOJ_UPGRADE_TARGET_URL）",
    };
    if (options.json) {
      console.error(JSON.stringify(errPayload, null, 2));
    } else {
      console.error(`[${errPayload.code}] ${errPayload.message}`);
    }
    return 1;
  }

  try {
    const report = await runUpgradeFromV010({
      sourceUrl,
      targetUrl,
      gatewayUrl,
      privateProblemPolicy: parsePrivateProblemPolicy(options.privateProblems),
      restrictedContestPolicy: parseRestrictedContestPolicy(
        options.restrictedContests,
      ),
      dryRun: Boolean(options.dryRun),
    });
    if (options.json) {
      console.log(JSON.stringify({ ok: true, report }, null, 2));
    } else {
      console.log(formatUpgradeReport(report));
    }
    return 0;
  } catch (err) {
    const code = err instanceof UpgradeV010Error
      ? err.code
      : "TRANSACTION_FAILED";
    const message = err instanceof Error ? err.message : String(err);
    const details = err instanceof UpgradeV010Error ? err.details : undefined;
    if (options.json) {
      console.error(
        JSON.stringify({ ok: false, code, message, details }, null, 2),
      );
    } else {
      console.error(`[${code}] 升级失败: ${message}`);
    }
    return 1;
  }
}

if (import.meta.main) {
  let opts: UpgradeCliOptions;
  try {
    opts = parseUpgradeCliArgs(Deno.args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[INVALID_OPTIONS] 参数解析失败: ${message}`);
    console.error(USAGE_TEXT);
    Deno.exit(1);
  }
  if (opts.help) {
    console.log(USAGE_TEXT);
    Deno.exit(0);
  }
  const code = await executeUpgradeCli(opts);
  Deno.exit(code);
}
