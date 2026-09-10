/**
 * 竞赛风控查询。
 *
 * 这里仅提供候选关联和时间线，不作自动封禁、取消成绩或其他判罚。
 * client_ip 只来自可信代理解析后的服务端字段，且只对具备风控权限的管理员开放。
 */
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import {
  contests,
  problems,
  submissions,
  users,
} from "../../../shared/db/schema.ts";
import { NotFoundError } from "../../../shared/base/errors.ts";
import { getSetting } from "../../system/index.ts";
import { logger } from "../../../shared/base/logging.ts";

export interface ContestIpGroupAccount {
  user_id: string;
  username: string;
  submission_count: number;
  first_submission_at: string;
  last_submission_at: string;
}

export interface ContestIpGroup {
  ip: string;
  account_count: number;
  submission_count: number;
  first_submission_at: string;
  last_submission_at: string;
  accounts: ContestIpGroupAccount[];
}

export interface ContestIpTimelineItem {
  submission_id: string;
  user_id: string;
  username: string;
  problem_id: string;
  problem_title: string;
  language: string;
  status: string;
  created_at: string;
}

type AntiCheatRow = {
  ip: string | null;
  submission_id: string;
  user_id: string;
  username: string;
  problem_id: string;
  problem_title: string;
  language: string;
  status: string;
  created_at: string;
};

/**
 * 断言竞赛存在，不存在时抛 NotFoundError。
 *
 * 供本文件与 `contest-similarity.ts` 共用，保证同域风控端点对「竞赛不存在」
 * 的响应语义一致（404 而不是空结果）。
 */
export async function assertContestExists(contestId: string): Promise<void> {
  const db = getDb();
  const [row] = await db.select({ id: contests.id }).from(contests).where(
    eq(contests.id, contestId),
  ).limit(1);
  if (!row) throw new NotFoundError("竞赛不存在");
}

async function queryRows(
  contestId: string,
  ip?: string,
): Promise<AntiCheatRow[]> {
  const db = getDb();
  const conditions = [
    eq(submissions.contest_id, contestId),
    isNotNull(submissions.client_ip),
  ];
  if (ip) conditions.push(eq(submissions.client_ip, ip));
  const rows = await db.select({
    ip: submissions.client_ip,
    submission_id: submissions.public_id,
    user_id: submissions.user_id,
    username: users.username,
    problem_id: submissions.problem_id,
    problem_title: problems.title,
    language: submissions.language,
    status: submissions.status,
    created_at: submissions.created_at,
  }).from(submissions)
    .innerJoin(users, eq(users.id, submissions.user_id))
    .innerJoin(problems, eq(problems.id, submissions.problem_id))
    .where(and(...conditions))
    .orderBy(asc(submissions.created_at));
  return rows as AntiCheatRow[];
}

function aggregateGroups(
  rows: AntiCheatRow[],
  minAccounts: number,
): ContestIpGroup[] {
  const groups = new Map<string, Map<string, ContestIpGroupAccount>>();
  for (const row of rows) {
    if (!row.ip) continue;
    let accounts = groups.get(row.ip);
    if (!accounts) {
      accounts = new Map();
      groups.set(row.ip, accounts);
    }
    const previous = accounts.get(row.user_id);
    if (previous) {
      previous.submission_count += 1;
      previous.last_submission_at = row.created_at;
    } else {
      accounts.set(row.user_id, {
        user_id: row.user_id,
        username: row.username,
        submission_count: 1,
        first_submission_at: row.created_at,
        last_submission_at: row.created_at,
      });
    }
  }
  return [...groups.entries()]
    .filter(([, accounts]) => accounts.size >= minAccounts)
    .map(([ip, accounts]) => {
      const accountList = [...accounts.values()];
      const timestamps = accountList.flatMap((item) => [
        item.first_submission_at,
        item.last_submission_at,
      ]).sort();
      return {
        ip,
        account_count: accountList.length,
        submission_count: accountList.reduce(
          (sum, item) => sum + item.submission_count,
          0,
        ),
        first_submission_at: timestamps[0]!,
        last_submission_at: timestamps[timestamps.length - 1]!,
        accounts: accountList,
      };
    })
    .sort((a, b) => b.last_submission_at.localeCompare(a.last_submission_at));
}

/** 查询竞赛内同 IP 的多账号候选组。 */
export async function listContestIpGroups(
  contestId: string,
  options: { minAccounts?: number; page?: number; perPage?: number } = {},
): Promise<
  { data: ContestIpGroup[]; total: number; page: number; perPage: number }
> {
  await assertContestExists(contestId);
  const minAccounts = Math.max(2, Math.min(100, options.minAccounts ?? 2));
  const page = Math.max(1, options.page ?? 1);
  const perPage = Math.max(1, Math.min(100, options.perPage ?? 20));
  const groups = aggregateGroups(await queryRows(contestId), minAccounts);
  return {
    data: groups.slice((page - 1) * perPage, page * perPage),
    total: groups.length,
    page,
    perPage,
  };
}

/** 查询指定 IP 的竞赛提交时间线；不返回源代码、邮箱或其他敏感字段。 */
export async function listContestIpTimeline(
  contestId: string,
  ip: string,
): Promise<ContestIpTimelineItem[]> {
  await assertContestExists(contestId);
  const normalizedIp = ip.trim();
  if (!normalizedIp) return [];
  return (await queryRows(contestId, normalizedIp)).map((row) => ({
    submission_id: row.submission_id,
    user_id: row.user_id,
    username: row.username,
    problem_id: row.problem_id,
    problem_title: row.problem_title,
    language: row.language,
    status: row.status,
    created_at: row.created_at,
  }));
}

/** 按保留期限清理提交来源 IP，保留提交记录和评测结果。 */
export async function cleanupExpiredSubmissionClientIps(
  retentionDays: number,
): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000)
    .toISOString();
  const db = getDb();
  const result = await db.update(submissions).set({ client_ip: null }).where(
    and(
      isNotNull(submissions.client_ip),
      sql`${submissions.created_at} < ${cutoff}`,
    ),
  );
  const row = result as unknown as {
    affectedRows?: number;
    rowCount?: number;
    count?: number;
  };
  return row.affectedRows ?? row.rowCount ?? row.count ?? 0;
}

/** 启动来源 IP 保留任务；仅清理 IP 字段，不删除提交、代码或成绩。 */
export function startContestAntiCheatRetentionTask(): void {
  const configured = getSetting("anti_cheat_ip_retention_days")?.value;
  const days = typeof configured === "number" ? Math.floor(configured) : 180;
  if (days <= 0) {
    logger.info("竞赛风控 IP 清理任务已禁用", { retention_days: days });
    return;
  }
  const cleanup = () =>
    cleanupExpiredSubmissionClientIps(days)
      .then((removed) => {
        if (removed > 0) {
          logger.info("竞赛风控 IP 清理完成", {
            removed,
            retention_days: days,
          });
        }
      })
      .catch((err) => logger.error("竞赛风控 IP 清理失败", { err }));
  void cleanup();
  setInterval(() => void cleanup(), 86400 * 1000);
  logger.info("竞赛风控 IP 保留任务已启动", { retention_days: days });
}
