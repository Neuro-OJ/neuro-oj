/**
 * Admin contest 子域路由。
 *
 * 挂载前缀：/api/v1/admin/contest（由 domains/admin/index.ts 以 /contest 挂载）。
 * 由原 contest 域 `admin-contests.ts` 迁移而来。
 *
 * 审计分层：
 * - ranking-snapshot 发布在 contest-ranking service 内已调用 logAudit，
 *   因此保持 service 层为唯一审计源，路由层不重复写。
 * - 其余写操作（create/update/delete、participants add/remove、kind change、
 *   reset-code）原先未在 service 层审计，由路由层 withAudit 作为唯一审计源。
 */
import { Hono } from "hono";
import type { Context } from "hono";
import type { AuthEnv } from "../../identity/index.ts";
import { parseJsonBody } from "../../../shared/http/request.ts";
import { BadRequestError } from "../../../shared/base/errors.ts";
import {
  buildPaginationMeta,
  parsePagination,
} from "../../../shared/http/pagination.ts";
import {
  addParticipants,
  createContest,
  deleteContest,
  getContest,
  getContestProblems,
  listContests,
  listParticipants,
  removeParticipant,
  resolveContestId,
  updateContest,
} from "../../contest/services/contests.ts";
import type {
  CreateContestInput,
  KaggleRankingRow,
  UpdateContestInput,
} from "../../contest/types/contests.ts";
import { isValidContestKind } from "../../contest/types/contests.ts";
import { isValidContestType } from "../../contest/types/contests.ts";
import { listSubmissions } from "../../submission/index.ts";
import { resolveUserId } from "../../identity/index.ts";
import {
  getContestSettlementStatus,
  getLatestContestRankingSnapshot,
  listContestRankingSnapshots,
  publishContestRankingSnapshot,
} from "../../contest/services/contest-ranking.ts";
import {
  listContestIpGroups,
  listContestIpTimeline,
} from "../../contest/services/contest-anti-cheat.ts";
import { assertPermission } from "../../identity/index.ts";
import { withAudit } from "../services/admin-audit.ts";
import type { AuditMeta } from "../types/admin-audit.ts";

/** 路由层审计用的临时请求体缓存（withAudit 在 handler 返回后才构建 detail）。 */
const auditBodies = new WeakMap<object, unknown>();

function setAuditBody(c: object, body: unknown): void {
  auditBodies.set(c, body);
}

function getAuditBody<T>(c: object): T | undefined {
  return auditBodies.get(c) as T | undefined;
}

/** 将 AuthEnv handler 适配为 withAudit 接受的 Context handler。 */
function auditRoute(
  meta: AuditMeta,
  handler: (c: Context<AuthEnv>) => Promise<Response>,
) {
  return withAudit(meta)(handler as (c: Context) => Promise<Response>);
}

/**
 * 管理端竞赛管理路由（挂载前缀 /api/v1/admin/contest，见 admin/index.ts）。
 *
 * 提供：
 * - GET/POST /contests                    竞赛列表 / 创建
 * - GET/PUT/DELETE /contests/:id          竞赛详情 / 更新 / 删除
 * - GET/POST /contests/:id/participants   参与者列表 / 批量添加
 * - DELETE /contests/:id/participants/:userId  移除参与者
 * - GET /contests/:id/submissions         竞赛提交列表
 */
const router = new Hono<AuthEnv>();

/**
 * GET /contests —— 竞赛列表（管理端，含非公开竞赛）。
 * 权限：管理员。query：page、perPage、type。响应：{ data, pagination }。
 */
router.get("/contests", async (c) => {
  const { page, perPage } = parsePagination(c);
  const typeQuery = c.req.query("type");
  if (typeQuery && !isValidContestType(typeQuery)) {
    throw new BadRequestError("竞赛类型不合法");
  }
  const type = typeQuery && isValidContestType(typeQuery)
    ? typeQuery
    : undefined;
  const result = await listContests({ page, perPage, type, showAll: true });
  return c.json({
    data: result.data,
    pagination: buildPaginationMeta(page, perPage, result.total),
  });
});

/**
 * GET /contests/:id —— 竞赛详情（含题目列表）。
 * 权限：管理员。path：id。响应：{ data: { ...contest, problems } }。
 */
router.get("/contests/:id", async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const [contest, problems] = await Promise.all([
    getContest(contestId),
    getContestProblems(contestId),
  ]);
  return c.json({ data: { ...contest, problems } });
});

/**
 * POST /contests —— 创建竞赛。
 * 权限：管理员。body：CreateContestInput。响应：201 { data }。
 */
router.post(
  "/contests",
  auditRoute(
    {
      action: "contest.create",
      target: (c) => {
        const body = getAuditBody<{ result?: { id?: string } }>(c);
        return body?.result?.id
          ? { type: "contest", id: body.result.id }
          : undefined;
      },
      buildDetail: (c) => {
        const body = getAuditBody<{
          input?: CreateContestInput;
          result?: {
            id?: string;
            title?: string;
            type?: string;
            kind?: string;
          };
        }>(c);
        return {
          action: "contest.create",
          contest_id: body?.result?.id ?? "",
          title: body?.input?.title ?? body?.result?.title ?? "",
          type: body?.input?.type ?? body?.result?.type ?? "",
          kind: body?.input?.kind ?? body?.result?.kind ?? "",
        };
      },
    },
    async (c) => {
      const body = await parseJsonBody<CreateContestInput>(c);
      const data = await createContest(body, c.get("userId"), true);
      setAuditBody(c, { input: body, result: data });
      return c.json({ data }, 201);
    },
  ),
);

/**
 * PUT /contests/:id —— 更新竞赛。
 * 权限：管理员。path：id。body：UpdateContestInput。响应：{ data }。
 */
router.put(
  "/contests/:id",
  auditRoute(
    {
      action: "contest.update",
      target: (c) => ({ type: "contest", id: c.req.param("id")! }),
      buildDetail: (c) => {
        const body = getAuditBody<UpdateContestInput>(c);
        return {
          action: "contest.update",
          contest_id: c.req.param("id")!,
          title: body?.title,
          type: body?.type,
          kind: body?.kind,
          is_public: body?.is_public,
        };
      },
    },
    async (c) => {
      const contestId = await resolveContestId(c.req.param("id") as string);
      const body = await parseJsonBody<UpdateContestInput>(c);
      setAuditBody(c, body);
      const data = await updateContest(
        contestId,
        body,
        true,
      );
      return c.json({ data });
    },
  ),
);

/**
 * DELETE /contests/:id —— 删除竞赛。
 * 权限：管理员。path：id。响应：204 无内容。
 */
router.delete(
  "/contests/:id",
  auditRoute(
    {
      action: "contest.delete",
      target: (c) => ({ type: "contest", id: c.req.param("id")! }),
      buildDetail: (c) => ({
        action: "contest.delete",
        contest_id: c.req.param("id")!,
      }),
    },
    async (c) => {
      const contestId = await resolveContestId(c.req.param("id") as string);
      await deleteContest(contestId);
      return c.body(null, 204);
    },
  ),
);

/**
 * GET /contests/:id/participants —— 竞赛参与者列表。
 * 权限：管理员。path：id。响应：{ data }。
 */
router.get("/contests/:id/participants", async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const data = await listParticipants(contestId);
  return c.json({ data });
});

/**
 * POST /contests/:id/participants —— 批量添加参与者。
 * 权限：管理员。path：id。body：用户 ID 数组。响应：201 { data: { added } }。
 */
router.post(
  "/contests/:id/participants",
  auditRoute(
    {
      action: "contest.participants_add",
      target: (c) => ({ type: "contest", id: c.req.param("id")! }),
      buildDetail: (c) => {
        const body = getAuditBody<{ user_ids?: string[] }>(c);
        return {
          action: "contest.participants_add",
          contest_id: c.req.param("id")!,
          user_ids: body?.user_ids ?? [],
        };
      },
    },
    async (c) => {
      const contestId = await resolveContestId(c.req.param("id") as string);
      const userIds = await parseJsonBody<string[]>(c);
      if (!Array.isArray(userIds)) {
        throw new BadRequestError("请求体必须为用户 ID 数组");
      }
      const resolvedIds = await Promise.all(
        userIds.map((v) => resolveUserId(v)),
      );
      setAuditBody(c, { user_ids: resolvedIds });
      const added = await addParticipants(contestId, resolvedIds);
      return c.json({ data: { added } }, 201);
    },
  ),
);

/**
 * DELETE /contests/:id/participants/:userId —— 移除某位参与者。
 * 权限：管理员。path：id、userId。响应：204 无内容。
 */
router.delete(
  "/contests/:id/participants/:userId",
  auditRoute(
    {
      action: "contest.participants_remove",
      target: (c) => ({ type: "contest", id: c.req.param("id")! }),
      buildDetail: (c) => ({
        action: "contest.participants_remove",
        contest_id: c.req.param("id")!,
        user_id: c.req.param("userId")!,
      }),
    },
    async (c) => {
      const contestId = await resolveContestId(c.req.param("id") as string);
      const targetUserId = await resolveUserId(c.req.param("userId") as string);
      await removeParticipant(
        contestId,
        targetUserId,
      );
      return c.body(null, 204);
    },
  ),
);

/**
 * PATCH /contests/:id/kind —— 邀请赛转公开赛。
 * 权限：管理员。path：id。body：{ kind: "public" }。响应：{ data }。
 */
router.patch(
  "/contests/:id/kind",
  auditRoute(
    {
      action: "contest.kind_change",
      target: (c) => ({ type: "contest", id: c.req.param("id")! }),
      buildDetail: (c) => {
        const body = getAuditBody<{ kind?: unknown }>(c);
        return {
          action: "contest.kind_change",
          contest_id: c.req.param("id")!,
          to: body?.kind === "public" ? "public" : "",
        };
      },
    },
    async (c) => {
      const contestId = await resolveContestId(c.req.param("id") as string);
      const body = await parseJsonBody<{ kind?: unknown }>(c);
      if (body.kind !== "public" || !isValidContestKind(body.kind)) {
        throw new BadRequestError("仅支持将邀请赛转为公开赛（kind=public）");
      }
      setAuditBody(c, body);
      const data = await updateContest(
        contestId,
        { kind: "public", is_public: true },
        true,
      );
      return c.json({ data });
    },
  ),
);

/**
 * POST /contests/:id/reset-code —— 重置邀请赛邀请码。
 * 权限：管理员。path：id。响应：{ data: { code, contest } }。
 */
router.post(
  "/contests/:id/reset-code",
  auditRoute(
    {
      action: "contest.reset_code",
      target: (c) => ({ type: "contest", id: c.req.param("id")! }),
      buildDetail: (c) => ({
        action: "contest.reset_code",
        contest_id: c.req.param("id")!,
      }),
    },
    async (c) => {
      const contestId = await resolveContestId(c.req.param("id") as string);
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const bytes = crypto.getRandomValues(new Uint8Array(10));
      const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join(
        "",
      );
      const data = await updateContest(contestId, { password: code }, true);
      return c.json({ data: { code, contest: data } });
    },
  ),
);

/**
 * GET /contests/:id/submissions —— 竞赛提交列表。
 * 权限：管理员。path：id。query：page、perPage。响应：{ data, pagination }。
 */
router.get("/contests/:id/submissions", async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  await getContest(contestId);
  const { page, perPage } = parsePagination(c);
  const result = await listSubmissions({ contestId, page, perPage });
  return c.json({
    data: result.data,
    pagination: buildPaginationMeta(page, perPage, result.total),
  });
});

/**
 * GET /contests/:id/anti-cheat/ip-groups —— 竞赛内同 IP 多账号候选组。
 * 仅展示可信代理解析后的 IP；此结果是人工复核线索，不代表作弊结论。
 */
router.get("/contests/:id/anti-cheat/ip-groups", async (c) => {
  await assertPermission(c, "contest:anti_cheat_read");
  const contestId = await resolveContestId(c.req.param("id") as string);
  const minAccounts = Number(c.req.query("min_accounts") ?? "2");
  const page = Number(c.req.query("page") ?? "1");
  const perPage = Number(c.req.query("per_page") ?? "20");
  const result = await listContestIpGroups(contestId, {
    minAccounts: Number.isFinite(minAccounts) ? minAccounts : 2,
    page: Number.isFinite(page) ? page : 1,
    perPage: Number.isFinite(perPage) ? perPage : 20,
  });
  return c.json({
    data: result.data,
    pagination: {
      page: result.page,
      per_page: result.perPage,
      total: result.total,
      total_pages: Math.ceil(result.total / result.perPage),
    },
    data_policy: {
      purpose: "竞赛期间账号关联与提交时间线人工复核",
      retention_days: 180,
      automated_penalty: false,
    },
  });
});

/** GET /contests/:id/anti-cheat/timeline?ip=... —— 同 IP 提交时间线。 */
router.get("/contests/:id/anti-cheat/timeline", async (c) => {
  await assertPermission(c, "contest:anti_cheat_read");
  const ip = c.req.query("ip")?.trim();
  if (!ip) throw new BadRequestError("缺少 ip 查询参数");
  const contestId = await resolveContestId(c.req.param("id") as string);
  const data = await listContestIpTimeline(contestId, ip);
  return c.json({
    data,
    data_policy: {
      purpose: "竞赛期间账号关联与提交时间线人工复核",
      retention_days: 180,
      automated_penalty: false,
    },
  });
});

/** 查看正式成绩发布门禁及待处理/失败评测明细。 */
router.get("/contests/:id/ranking-snapshots/readiness", async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const data = await getContestSettlementStatus(contestId);
  return c.json({ data });
});

/** 发布不可变的正式成绩快照；重复请求会生成新版本并保留审计说明。 */
router.post("/contests/:id/ranking-snapshots", async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const rawBody = await c.req.text();
  let body: { note?: string; allow_failed?: boolean } = {};
  if (rawBody.trim()) {
    try {
      body = JSON.parse(rawBody) as { note?: string; allow_failed?: boolean };
    } catch {
      throw new BadRequestError("请求体格式错误：需要有效的 JSON");
    }
  }
  const data = await publishContestRankingSnapshot(
    contestId,
    c.get("userId"),
    body.note ?? "",
    { allowFailed: body.allow_failed === true },
  );
  return c.json({ data }, 201);
});

/** 获取当前正式成绩快照；实时排名接口仍用于临时成绩。 */
router.get("/contests/:id/ranking-snapshots/latest", async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const data = await getLatestContestRankingSnapshot(contestId);
  return c.json({ data });
});

/** 获取正式成绩历史版本元数据；rows 只在具体版本导出时返回。 */
router.get("/contests/:id/ranking-snapshots", async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const data = await listContestRankingSnapshots(contestId);
  return c.json({ data });
});

/** 导出最新正式成绩 JSON，供 CSV 之外的核对与归档使用。 */
router.get("/contests/:id/ranking-snapshots/latest.json", async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const snapshot = await getLatestContestRankingSnapshot(contestId);
  if (!snapshot) return c.json({ error: "尚未发布正式成绩" }, 404);
  return c.json({
    data: {
      contest_id: contestId,
      version: snapshot.version,
      note: snapshot.note,
      created_by: snapshot.created_by,
      created_at: snapshot.created_at,
      rows: snapshot.rows,
    },
  });
});

/** 导出正式成绩，避免直接导出可被重测改变的实时排名。 */
router.get("/contests/:id/ranking-snapshots/latest.csv", async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const snapshot = await getLatestContestRankingSnapshot(contestId);
  if (!snapshot) return c.json({ error: "尚未发布正式成绩" }, 404);
  const rows = snapshot.rows as KaggleRankingRow[];
  const csv = [
    "版本,排名,用户,总分,最后提交时间,题目提交与评测明细(JSON)",
    ...rows.map((row) =>
      [
        snapshot.version,
        row.rank,
        row.username,
        row.total_score,
        row.last_submission_at ?? "",
        JSON.stringify(row.problem_scores),
      ].map(csvCell).join(",")
    ),
  ].join("\n");
  return new Response("\uFEFF" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition":
        `attachment; filename="contest-${contestId}-ranking.csv"`,
    },
  });
});

function csvCell(value: unknown): string {
  let text = String(value ?? "");
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export default router;
