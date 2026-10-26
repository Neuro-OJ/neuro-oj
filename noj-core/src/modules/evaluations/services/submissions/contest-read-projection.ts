import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  contestParticipants,
  contests,
  domains,
} from "../../../../shared/db/schema.ts";
import { loadWorkspace } from "../../../access/contracts/cross-module/workspace_services_access.ts";
import type { ContestType } from "../../../contests/types/contests.ts";
import { applySubmissionProjection } from "./submission-projection.ts";

/** 批量读取当前赛制与参赛关系，列表、详情共用，避免逐条查询比赛。 */
export async function projectContestSubmissionReads<
  T extends {
    contest_id: string | null;
    user_id: string;
    id: string;
    problem_id: string;
  },
>(
  rows: readonly T[],
  viewerId: string | null,
  platformAdmin = false,
): Promise<T[]> {
  const ids = [
    ...new Set(rows.flatMap((r) => r.contest_id ? [r.contest_id] : [])),
  ];
  if (platformAdmin || !ids.length) return [...rows];
  const db = getDb();
  const contestRows = await db.select().from(contests).where(
    inArray(contests.id, ids),
  );
  const memberships = viewerId
    ? await db.select({ id: contestParticipants.contest_id })
      .from(contestParticipants).where(
        and(
          inArray(contestParticipants.contest_id, ids),
          eq(contestParticipants.user_id, viewerId),
        ),
      )
    : [];
  const joined = new Set(memberships.map((r) => r.id));
  const byId = new Map(contestRows.map((c) => [c.id, c]));
  const domainIds = [
    ...new Set(contestRows.flatMap((c) => c.domain_id ? [c.domain_id] : [])),
  ];
  const domainRows = domainIds.length
    ? await db.select({ id: domains.id, slug: domains.slug }).from(domains)
      .where(inArray(domains.id, domainIds))
    : [];
  const workspaces = new Map(
    await Promise.all(
      domainRows.map(async (domain) =>
        [domain.id, await loadWorkspace(domain.slug, viewerId)] as const
      ),
    ),
  );
  const now = Date.now();
  return rows.map((row) => {
    const contest = row.contest_id ? byId.get(row.contest_id) : null;
    if (!contest) return row;
    const running = Date.parse(contest.start_time) <= now &&
      now < Date.parse(contest.end_time);
    if (!running || contest.type === "kaggle" && row.user_id === viewerId) {
      return row;
    }
    return applySubmissionProjection(
      row as unknown as Record<string, unknown>,
      {
        viewerId,
        isAdmin: false,
        isOwner: row.user_id === viewerId,
        contest: {
          running,
          participant: joined.has(contest.id),
          organizer: contest.domain_id
            ? (() => {
              const workspace = workspaces.get(contest.domain_id!);
              return !!workspace &&
                (workspace.platformAdmin ||
                  workspace.context.domainPermissions.has("contest:manage") ||
                  viewerId === contest.created_by &&
                    workspace.context.domainPermissions.has(
                      "contest:manage_own",
                    ));
            })()
            : viewerId !== null && contest.created_by === viewerId,
          type: contest.type as ContestType,
        },
      },
    ) as unknown as T;
  });
}
