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
import {
  findSimilarSubmissions,
  MAX_SIMILAR_PAIR_LIMIT,
} from "../../contest/services/contest-similarity.ts";
import { resolveProblemIdOrThrow } from "../../catalog/index.ts";
import { assertPermission } from "../../identity/index.ts";
import { withAudit } from "../services/admin-audit.ts";
import type { AuditMeta } from "../types/admin-audit.ts";
import { adminVersionMiddleware } from "../middleware/admin-version.ts";

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
  adminVersionMiddleware(async (c) => {
    const id = await resolveContestId(c.req.param("id") as string);
    return (await getContest(id)).updated_at;
  }),
  auditRoute(
    {
      action: "contest.update",
      target: (c) => {
        const body = getAuditBody<{ contestId?: string }>(c);
        return body?.contestId
          ? { type: "contest", id: body.contestId }
          : undefined;
      },
      buildDetail: (c) => {
        const body = getAuditBody<
          { contestId?: string; input?: UpdateContestInput }
        >(c);
        return {
          action: "contest.update",
          contest_id: body?.contestId ?? "",
          title: body?.input?.title,
          type: body?.input?.type,
          kind: body?.input?.kind,
          is_public: body?.input?.is_public,
        };
      },
    },
    async (c) => {
      const contestId = await resolveContestId(c.req.param("id") as string);
      const body = await parseJsonBody<UpdateContestInput>(c);
      setAuditBody(c, { input: body, contestId });
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
  adminVersionMiddleware(async (c) => {
    const id = await resolveContestId(c.req.param("id") as string);
    return (await getContest(id)).updated_at;
  }),
  auditRoute(
    {
      action: "contest.delete",
      target: (c) => {
        const body = getAuditBody<{ contestId?: string }>(c);
        return body?.contestId
          ? { type: "contest", id: body.contestId }
          : undefined;
      },
      buildDetail: (c) => {
        const body = getAuditBody<{ contestId?: string }>(c);
        return {
          action: "contest.delete",
          contest_id: body?.contestId ?? "",
        };
      },
    },
    async (c) => {
      const contestId = await resolveContestId(c.req.param("id") as string);
      setAuditBody(c, { contestId });
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
      target: (c) => {
        const body = getAuditBody<{ contestId?: string }>(c);
        return body?.contestId
          ? { type: "contest", id: body.contestId }
          : undefined;
      },
      buildDetail: (c) => {
        const body = getAuditBody<{ contestId?: string; user_ids?: string[] }>(
          c,
        );
        return {
          action: "contest.participants_add",
          contest_id: body?.contestId ?? "",
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
      setAuditBody(c, { contestId, user_ids: resolvedIds });
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
      target: (c) => {
        const body = getAuditBody<{ contestId?: string }>(c);
        return body?.contestId
          ? { type: "contest", id: body.contestId }
          : undefined;
      },
      buildDetail: (c) => {
        const body = getAuditBody<{ contestId?: string; userId?: string }>(c);
        return {
          action: "contest.participants_remove",
          contest_id: body?.contestId ?? "",
          user_id: body?.userId ?? "",
        };
      },
    },
    async (c) => {
      const contestId = await resolveContestId(c.req.param("id") as string);
      const targetUserId = await resolveUserId(c.req.param("userId") as string);
      setAuditBody(c, { contestId, userId: targetUserId });
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
  adminVersionMiddleware(async (c) => {
    const id = await resolveContestId(c.req.param("id") as string);
    return (await getContest(id)).updated_at;
  }),
  auditRoute(
    {
      action: "contest.kind_change",
      target: (c) => {
        const body = getAuditBody<{ contestId?: string }>(c);
        return body?.contestId
          ? { type: "contest", id: body.contestId }
          : undefined;
      },
      buildDetail: (c) => {
        const body = getAuditBody<{ contestId?: string; kind?: unknown }>(c);
        return {
          action: "contest.kind_change",
          contest_id: body?.contestId ?? "",
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
      setAuditBody(c, { contestId, kind: body.kind });
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
  adminVersionMiddleware(async (c) => {
    const id = await resolveContestId(c.req.param("id") as string);
    return (await getContest(id)).updated_at;
  }),
  auditRoute(
    {
      action: "contest.reset_code",
      target: (c) => {
        const body = getAuditBody<{ contestId?: string }>(c);
        return body?.contestId
          ? { type: "contest", id: body.contestId }
          : undefined;
      },
      buildDetail: (c) => {
        const body = getAuditBody<{ contestId?: string }>(c);
        return {
          action: "contest.reset_code",
          contest_id: body?.contestId ?? "",
        };
      },
    },
    async (c) => {
      const contestId = await resolveContestId(c.req.param("id") as string);
      const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      const bytes = crypto.getRandomValues(new Uint8Array(10));
      const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join(
        "",
      );
      setAuditBody(c, { contestId });
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

/**
 * GET /contests/:id/anti-cheat/similar-submissions —— 竞赛内互相高度相似的提交对。
 *
 * 权限：contest:anti_cheat_read（与同文件其余风控端点一致）。
 * query：
 * - `threshold`：相似度阈值，(0, 1]，默认 0.8；
 * - `limit`：返回对数上限，1-200，默认 50；
 * - `problem_id`：可选，支持 UUID / display_id，用于把分析范围缩到单题。
 *
 * 响应只含提交标识、用户、题目、语言、相似度与指纹统计，**不含源代码**；
 * 结果是供人工复核的线索，不代表作弊结论。
 */
router.get("/contests/:id/anti-cheat/similar-submissions", async (c) => {
  await assertPermission(c, "contest:anti_cheat_read");
  const contestId = await resolveContestId(c.req.param("id") as string);
  const threshold = parseSimilarityThreshold(c.req.query("threshold"));
  const limit = parseSimilarityLimit(c.req.query("limit"));
  const problemRef = c.req.query("problem_id")?.trim();
  const problemId = problemRef
    ? await resolveProblemIdOrThrow(problemRef)
    : undefined;
  const result = await findSimilarSubmissions(contestId, {
    threshold,
    limit,
    problemId,
  });
  return c.json({
    data: result.data,
    meta: {
      threshold: result.threshold,
      limit: result.limit,
      total: result.total,
      truncated: result.truncated,
      candidates: result.candidates,
      // 评审补充：区分「取了多少候选」与「真正比较了多少」——
      // 只看 candidates 会在候选含大量过短提交时高估分析覆盖率。
      participating: result.participating,
      skipped: result.skipped,
      buckets: result.buckets,
      max_submissions: result.max_submissions,
    },
    data_policy: {
      // 与同文件的 ip-groups / timeline 保持同一形状（评审指出此处曾多出 source、
      // 少了 retention_days，而 noj-ui/composables/useContests.ts 把
      // retention_days 声明为必需字段）。
      purpose: "竞赛期间代码相似度人工复核",
      retention_days: 180,
      automated_penalty: false,
    },
  });
});

/** 解析 `threshold` 查询参数：缺省时返回 undefined，由服务层套用默认阈值。 */
function parseSimilarityThreshold(raw: string | undefined): number | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new BadRequestError("threshold 必须为大于 0 且不超过 1 的小数");
  }
  return value;
}

/** 解析 `limit` 查询参数：缺省时返回 undefined，由服务层套用默认上限。 */
function parseSimilarityLimit(raw: string | undefined): number | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > MAX_SIMILAR_PAIR_LIMIT) {
    throw new BadRequestError(
      `limit 必须为 1 到 ${MAX_SIMILAR_PAIR_LIMIT} 之间的整数`,
    );
  }
  return value;
}

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
