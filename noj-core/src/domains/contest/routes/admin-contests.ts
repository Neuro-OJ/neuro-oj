import { Hono } from "hono";
import type { AuthEnv } from "./../../identity/index.ts";
import { parseJsonBody } from "./../../../shared/http/request.ts";
import { BadRequestError } from "./../../../shared/base/errors.ts";
import {
  buildPaginationMeta,
  parsePagination,
} from "./../../../shared/http/pagination.ts";
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
} from "../services/contests.ts";
import type {
  CreateContestInput,
  KaggleRankingRow,
  UpdateContestInput,
} from "./../types/contests.ts";
import { isValidContestType } from "./../types/contests.ts";
import { listSubmissions } from "../../submission/index.ts";
import { resolveUserId } from "../../identity/index.ts";
import {
  getContestSettlementStatus,
  getLatestContestRankingSnapshot,
  listContestRankingSnapshots,
  publishContestRankingSnapshot,
} from "../services/contest-ranking.ts";
import {
  listContestIpGroups,
  listContestIpTimeline,
} from "../services/contest-anti-cheat.ts";
import { assertPermission } from "../../identity/index.ts";

/**
 * 管理端竞赛管理路由（挂载前缀 /api/v1/admin，见 admin/index.ts）。
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
router.post("/contests", async (c) => {
  const body = await parseJsonBody<CreateContestInput>(c);
  const data = await createContest(body, c.get("userId"), true);
  return c.json({ data }, 201);
});

/**
 * PUT /contests/:id —— 更新竞赛。
 * 权限：管理员。path：id。body：UpdateContestInput。响应：{ data }。
 */
router.put("/contests/:id", async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const body = await parseJsonBody<UpdateContestInput>(c);
  const data = await updateContest(
    contestId,
    body,
    true,
  );
  return c.json({ data });
});

/**
 * DELETE /contests/:id —— 删除竞赛。
 * 权限：管理员。path：id。响应：204 无内容。
 */
router.delete("/contests/:id", async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  await deleteContest(contestId);
  return c.body(null, 204);
});

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
router.post("/contests/:id/participants", async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const userIds = await parseJsonBody<string[]>(c);
  if (!Array.isArray(userIds)) {
    throw new BadRequestError("请求体必须为用户 ID 数组");
  }
  const resolvedIds = await Promise.all(userIds.map((v) => resolveUserId(v)));
  const added = await addParticipants(contestId, resolvedIds);
  return c.json({ data: { added } }, 201);
});

/**
 * DELETE /contests/:id/participants/:userId —— 移除某位参与者。
 * 权限：管理员。path：id、userId。响应：204 无内容。
 */
router.delete("/contests/:id/participants/:userId", async (c) => {
  const contestId = await resolveContestId(c.req.param("id") as string);
  const targetUserId = await resolveUserId(c.req.param("userId") as string);
  await removeParticipant(
    contestId,
    targetUserId,
  );
  return c.body(null, 204);
});

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
