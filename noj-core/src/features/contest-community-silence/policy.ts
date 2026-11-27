/**
 * 赛时社区静默策略：配置解析、纯逻辑判定与数据库查询。
 *
 * 仅在进行中（`running`，排除 `pending` 筹备期与 `ended` 赛后期）的保密比赛上按
 * `community_silence_mode` 生效；题目级保密门控仍覆盖筹备期与赛期全程。
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "../../shared/db/connection.ts";
import type { Executor } from "../../shared/db/executor.ts";
import { contestParticipants, contests } from "../../shared/db/schema.ts";
import { DEFAULT_DOMAIN_ID } from "../../shared/workspace/types.ts";

export const COMMUNITY_SILENCE_MODES = [
  "none",
  "contest_participants",
  "domain_all",
] as const;

export type CommunitySilenceMode = typeof COMMUNITY_SILENCE_MODES[number];

const CONTEST_TIME_ISO_REGEX_SQL =
  "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";

function runningContestWindowSql() {
  return sql`CASE
    WHEN ${contests.start_time} ~ ${CONTEST_TIME_ISO_REGEX_SQL}
     AND ${contests.end_time} ~ ${CONTEST_TIME_ISO_REGEX_SQL}
     AND pg_input_is_valid(${contests.start_time}, 'timestamptz')
     AND pg_input_is_valid(${contests.end_time}, 'timestamptz')
    THEN ${contests.start_time}::timestamptz <= now()
     AND ${contests.end_time}::timestamptz > now()
    ELSE true
  END`;
}

/** 解析比赛配置中的赛时社区静默模式，缺省或未知值回落为 `domain_all`。 */
export function resolveCommunitySilenceMode(
  config: unknown,
): CommunitySilenceMode {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return "domain_all";
  }
  const raw = (config as Record<string, unknown>).community_silence_mode;
  return typeof raw === "string" &&
      COMMUNITY_SILENCE_MODES.includes(raw as CommunitySilenceMode)
    ? (raw as CommunitySilenceMode)
    : "domain_all";
}

/** 纯逻辑判定单场保密比赛在当前状态下是否应静默指定用户。 */
export function doesContestSilenceActor(input: {
  secrecyEnabled: boolean;
  status: "pending" | "running" | "ended";
  silenceMode: CommunitySilenceMode;
  isParticipant: boolean;
}): boolean {
  if (!input.secrecyEnabled || input.status !== "running") return false;
  if (input.silenceMode === "none") return false;
  if (input.silenceMode === "contest_participants") return input.isParticipant;
  return true;
}

/**
 * 判定指定域（或全站）当前是否存在会静默该用户的进行中保密比赛。
 */
export async function isActorSilencedByRunningContest(
  domainId?: string,
  executor: Executor = getDb(),
  actorId?: string | null,
): Promise<boolean> {
  const modeExpr =
    sql`COALESCE(${contests.config}->>'community_silence_mode', 'domain_all')`;
  const rows = await executor
    .select({ contestId: contests.id })
    .from(contests)
    .where(and(
      domainId
        ? or(
          eq(contests.domain_id, domainId),
          domainId === DEFAULT_DOMAIN_ID
            ? isNull(contests.domain_id)
            : undefined,
        )
        : undefined,
      eq(contests.secrecy_enabled, true),
      runningContestWindowSql(),
      sql`${modeExpr} <> 'none'`,
      actorId
        ? sql`(${modeExpr} = 'domain_all' OR (${modeExpr} = 'contest_participants' AND EXISTS (
          SELECT 1 FROM ${contestParticipants} cp
          WHERE cp.contest_id = ${contests.id} AND cp.user_id = ${actorId}
        )))`
        : sql`${modeExpr} = 'domain_all'`,
    ))
    .limit(1);
  return rows.length > 0;
}
