// 竞赛写操作：创建、更新、删除竞赛，以及竞赛 ID（UUID / public_id）解析。
import type { Executor } from "../../../shared/db/executor.ts";
import { rescheduleContestEducation } from "../../education/contracts/contest-facts.ts";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { enqueueSearchIndexTask } from "../../application/search-tasks.ts";
import {
  contestProblems,
  contests,
  problems,
  problemVersions,
} from "../../../shared/db/schema.ts";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import {
  generatePublicId,
  resolvePublicId,
} from "../../../shared/security/public-id.ts";
import {
  bumpProjectionRevision,
  globalScopeKey,
} from "../../evaluations/contracts/cross-module/services_versioning_projection.ts";
import { type ProblemContentV1 } from "../../problems/types/problem-content.ts";
import { DEFAULT_DOMAIN_ID } from "../../../shared/workspace/types.ts";
import { ensureDefaultWorkspaceTx } from "../../access/domains.ts";
import { createSystemActor } from "../../runtime/system-actors.ts";
import { findContestRow } from "./contest-row.ts";
import { resolveDomainContestProblems } from "./domain-problems.ts";
import { contestAllowsProblem } from "./contest-scoring.ts";
import {
  assertContestProblemAddable,
  normalizeContestConfig,
  normalizeProblems,
  normalizeRankingPolicy,
  normalizeTimes,
} from "./contest-input.ts";
import {
  type ContestConfig,
  type ContestResponse,
  type ContestType,
  type CreateContestInput,
  isValidContestType,
  type UpdateContestInput,
} from "../types/contests.ts";
import { getContest } from "./contest-read.ts";

/** 将 UUID 或 public_id 解析为内部竞赛 UUID；其它格式按主键兜底（兼容旧数据）。 */
export function resolveContestId(value: string): Promise<string> {
  return resolvePublicId(
    contests,
    contests.id,
    contests.public_id,
    "ct",
    value,
    "竞赛不存在",
  );
}

/**
 * 创建竞赛：校验输入、规范化配置与题目，事务写入竞赛及题目关联。
 *
 * @param input 创建竞赛的输入
 * @param userId 创建者用户 ID
 * @returns 创建后的竞赛响应
 * @throws {BadRequestError} 输入不合法（标题/类型/时间/配置/题目）时
 */
export async function createContest(
  input: CreateContestInput,
  userId: string,
  isAdmin = false,
  options: {
    executor?: Executor;
    domainId?: string;
    versions?: Map<string, string>;
    bindings?: Map<string, string>;
  } = {},
): Promise<ContestResponse> {
  if (!input.title.trim()) {
    throw new BadRequestError("竞赛标题不能为空");
  }
  if (!isValidContestType(input.type)) {
    throw new BadRequestError("竞赛类型不合法");
  }
  if (
    input.secrecy_enabled !== undefined &&
    typeof input.secrecy_enabled !== "boolean"
  ) {
    throw new BadRequestError("赛题保护必须为布尔值");
  }
  // 校验 + 规范化：落库形态统一为 toISOString()，保证读侧按时刻比较安全（C1）
  const times = normalizeTimes(input.start_time, input.end_time);
  const rankingPolicy = normalizeRankingPolicy({
    ...input,
    start_time: times.start_time,
    end_time: times.end_time,
    ranking_visibility: input.ranking_visibility ??
      (input.type === "oi"
        ? "hidden"
        : input.type === "kaggle"
        ? "public"
        : "participants"),
    freeze_duration_seconds: input.freeze_duration_seconds ?? (
      input.type === "acm" && !input.freeze_start_time
        ? Math.min(
          3600,
          Math.floor(
            (Date.parse(times.end_time) - Date.parse(times.start_time)) / 1000,
          ),
        )
        : 0
    ),
  });
  const config = normalizeContestConfig(input.type, input.config);
  const problemInputs = normalizeProblems(input.type, input.problems);
  const id = crypto.randomUUID();
  const publicId = generatePublicId("ct");
  const now = new Date().toISOString();
  const db = options.executor ?? getDb();

  await db.transaction(async (tx) => {
    if (!options.domainId) {
      await ensureDefaultWorkspaceTx(tx, createSystemActor("bootstrap"));
    }
    const domainId = options.domainId ?? DEFAULT_DOMAIN_ID;
    const latestVersions = options.versions ??
      await assertContestProblemAddable(
        problemInputs,
        userId,
        isAdmin,
        tx,
        input.type,
      );
    const bindings = options.bindings ?? (await resolveDomainContestProblems(
      tx,
      domainId,
      problemInputs.map((problem) => problem.problem_id),
      input.type,
    )).bindingIds;
    await tx.insert(contests).values({
      id,
      domain_id: domainId,
      public_id: publicId,
      title: input.title.trim(),
      description: input.description ?? "",
      start_time: times.start_time,
      end_time: times.end_time,
      ...rankingPolicy,
      type: input.type,
      kind: "public",
      secrecy_enabled: input.secrecy_enabled ?? true,
      config,
      // 旧字段不再参与授权，统一写入中性值。
      is_public: true,
      password: null,
      affect_global_ranking: input.affect_global_ranking ?? false,
      created_by: userId,
      announcement: input.announcement ?? "",
      created_at: now,
      updated_at: now,
    });
    await tx.insert(contestProblems).values(
      problemInputs.map((value) => ({
        contest_id: id,
        domain_id: domainId,
        domain_problem_binding_id: bindings.get(value.problem_id)!,
        ...value,
        // 创建即固定版本：钉在当时的已发布最新版，之后题库发布新版本不影响本竞赛
        // （换版必须走显式的「竞赛固定版本升级」操作，Handbook §4.1/§4.3）。
        pinned_version_id: latestVersions.get(value.problem_id)!,
      })),
    );
  });

  await enqueueSearchIndexTask("contest", id, "upsert", db);

  return getContest(id, undefined, db);
}

/**
 * 更新竞赛：仅更新传入的字段，并同步更新题目关联（若提供）。
 *
 * @param id 竞赛 UUID
 * @param input 更新竞赛的输入
 * @returns 更新后的竞赛响应
 * @throws {NotFoundError} 竞赛不存在时
 * @throws {BadRequestError} 输入不合法（类型/时间/配置/题目）时
 */
export async function updateContest(
  id: string,
  input: UpdateContestInput,
  isAdmin = false,
  options: {
    executor?: Executor;
    versions?: Map<string, string>;
    domainId?: string;
    bindings?: Map<string, string>;
  } = {},
): Promise<ContestResponse> {
  const existing = await findContestRow(id, options.executor);
  const type = input.type ?? existing.type as ContestType;
  if (!isValidContestType(type)) {
    throw new BadRequestError("竞赛类型不合法");
  }
  if (
    input.secrecy_enabled !== undefined &&
    typeof input.secrecy_enabled !== "boolean"
  ) {
    throw new BadRequestError("赛题保护必须为布尔值");
  }
  // 合并后的时间同样校验 + 规范化：既防新写入脏形态，也顺带把存量非规范行
  // （如带 +08:00 偏移的旧数据）收敛为规范形态（C1）
  const times = normalizeTimes(
    input.start_time ?? existing.start_time,
    input.end_time ?? existing.end_time,
  );
  const rankingPolicy = normalizeRankingPolicy({
    start_time: times.start_time,
    end_time: times.end_time,
    ranking_visibility: input.ranking_visibility ?? existing.ranking_visibility,
    freeze_start_time: input.freeze_start_time !== undefined
      ? input.freeze_start_time
      : existing.freeze_start_time,
    freeze_duration_seconds: input.freeze_duration_seconds ??
      existing.freeze_duration_seconds,
  });
  if (input.title !== undefined && !input.title.trim()) {
    throw new BadRequestError("竞赛标题不能为空");
  }

  const config = input.config !== undefined || input.type !== undefined
    ? normalizeContestConfig(type, input.config)
    : existing.config as ContestConfig;
  const problemInputs = input.problems === undefined
    ? undefined
    : normalizeProblems(type, input.problems);
  const db = options.executor ?? getDb();
  /** 本次更新涉及题目的最新已发布版本（在事务内校验题目可加入时一并取得）。 */
  let latestVersions: Map<string, string> | null = null;
  let bindings: Map<string, string> | null = null;
  const domainId = options.domainId ?? DEFAULT_DOMAIN_ID;
  if ((existing.domain_id ?? DEFAULT_DOMAIN_ID) !== domainId) {
    throw new NotFoundError("竞赛不存在");
  }

  await db.transaction(async (tx) => {
    const previousProblems = await tx.select({
      problem_id: contestProblems.problem_id,
    }).from(contestProblems).where(eq(contestProblems.contest_id, id));
    const hostIds = [
      ...new Set([
        ...previousProblems.map((row) => row.problem_id),
        ...(problemInputs ?? []).map((row) => row.problem_id),
      ]),
    ].sort();
    if (hostIds.length) {
      await tx.select({ id: problems.id }).from(problems).where(
        inArray(problems.id, hostIds),
      ).orderBy(problems.id).for("share");
    }
    const [locked] = await tx.select().from(contests).where(
      eq(contests.id, id),
    ).for("update");
    if (locked.type !== existing.type) {
      throw new ConflictError("赛制已变化，请重新读取比赛");
    }
    if (
      Date.now() >= Date.parse(locked.start_time) &&
      (input.type !== undefined && input.type !== locked.type ||
        input.config !== undefined || input.freeze_start_time !== undefined ||
        input.freeze_duration_seconds !== undefined ||
        input.secrecy_enabled !== undefined)
    ) {
      throw new ConflictError("开赛后不能修改赛制或计分配置");
    }
    if (problemInputs) {
      latestVersions = options.versions ?? await assertContestProblemAddable(
        problemInputs,
        existing.created_by ?? "",
        isAdmin,
        tx,
        type,
      );
      bindings = options.bindings ?? (await resolveDomainContestProblems(
        tx,
        domainId,
        problemInputs.map((problem) => problem.problem_id),
        type,
      )).bindingIds;
    } else if (type !== existing.type) {
      // 只切换赛制也要校验已选题目的固定版本，不能留下错误题型。
      const selected = await tx.select({ content: problemVersions.content })
        .from(contestProblems).innerJoin(
          problemVersions,
          eq(problemVersions.id, contestProblems.pinned_version_id),
        )
        .where(eq(contestProblems.contest_id, id));
      if (
        selected.some((row) =>
          !contestAllowsProblem(type, (row.content as ProblemContentV1).kind)
        )
      ) {
        throw new BadRequestError("新赛制不允许现有题目类型");
      }
    }

    const updates: Partial<typeof contests.$inferInsert> = {
      updated_at: new Date().toISOString(),
    };
    if (input.title !== undefined) updates.title = input.title.trim();
    if (input.description !== undefined) {
      updates.description = input.description;
    }
    if (input.start_time !== undefined) updates.start_time = times.start_time;
    if (input.end_time !== undefined) updates.end_time = times.end_time;
    if (input.ranking_visibility !== undefined) {
      updates.ranking_visibility = rankingPolicy.ranking_visibility;
    }
    if (input.freeze_start_time !== undefined) {
      updates.freeze_start_time = rankingPolicy.freeze_start_time;
    }
    if (input.freeze_duration_seconds !== undefined) {
      updates.freeze_duration_seconds = rankingPolicy.freeze_duration_seconds;
    }
    if (input.type !== undefined) updates.type = input.type;
    if (input.secrecy_enabled !== undefined) {
      updates.secrecy_enabled = input.secrecy_enabled;
    }
    // 访问由 Domain 决定，历史比赛分类与密码不再控制报名。
    updates.is_public = true;
    updates.kind = "public";
    updates.password = null;
    if (input.config !== undefined || input.type !== undefined) {
      updates.config = config;
    }
    if (input.affect_global_ranking !== undefined) {
      updates.affect_global_ranking = input.affect_global_ranking;
    }
    if (input.announcement !== undefined) {
      updates.announcement = input.announcement;
    }

    await tx.update(contests).set(updates).where(eq(contests.id, id));
    if (
      updates.end_time !== undefined && updates.end_time !== existing.end_time
    ) {
      await rescheduleContestEducation(tx, id, updates.end_time);
    }

    // 全站榜口径失效（2026-10-11 复审问题 8）：全站排名的过滤条件包含
    // `contests.end_time`（赛期结束才计入）与 `affect_global_ranking`，而时钟跨越
    // end_time 或这两列被修改都不产生任何提交/判定写入——不递增 revision，
    // 缓存与物化视图就会继续按旧口径命中。这里复用唯一递增入口
    // （`bumpProjectionRevision`），与投影/策略路径同一套缓存失效语义。
    if (
      input.start_time !== undefined ||
      input.end_time !== undefined ||
      input.affect_global_ranking !== undefined
    ) {
      await bumpProjectionRevision(tx, globalScopeKey());
    }

    if (problemInputs) {
      // 题目关联是「整体替换」：必须先读旧固定版本，否则编辑竞赛（改名/改时间）
      // 会把已固定的版本重置到最新版，等于静默换版（Handbook §4.3）。
      const previousBindings = new Map(
        (await tx.select().from(contestProblems).where(
          eq(contestProblems.contest_id, id),
        )).map((row) => [row.problem_id, row]),
      );
      await tx.delete(contestProblems).where(
        eq(contestProblems.contest_id, id),
      );
      await tx.insert(contestProblems).values(
        problemInputs.map((value) => {
          // 已有固定版本原样保留（编辑竞赛不得静默换版）；新加入的题目用本次
          // 解析出的最新已发布版本（assert 已保证存在，未发布题目直接 400）。
          const binding = previousBindings.get(value.problem_id);
          return {
            contest_id: id,
            domain_id: domainId,
            domain_problem_binding_id: bindings!.get(value.problem_id)!,
            ...value,
            pinned_version_id: binding?.pinned_version_id ??
              latestVersions!.get(value.problem_id)!,
            effective_version_mode: binding?.effective_version_mode ?? "any",
            required_version_id: binding?.required_version_id ?? null,
            effective_policy_revision: binding?.effective_policy_revision ?? 0,
          };
        }),
      );
    }
  });

  await enqueueSearchIndexTask("contest", id, "upsert", db);

  return getContest(id, undefined, db);
}

/**
 * 删除竞赛。
 *
 * @param id 竞赛 UUID
 * @throws {NotFoundError} 竞赛不存在时
 */
export async function deleteContest(id: string): Promise<void> {
  const db = getDb();
  const deleted = await db.delete(contests).where(eq(contests.id, id))
    .returning({
      id: contests.id,
    });
  if (deleted.length === 0) {
    throw new NotFoundError("竞赛不存在");
  }

  // 删除竞赛会把 `submissions.contest_id` 置空（onDelete set null），这些提交从
  // "竞赛口径"回到"练习口径"，全站榜的过滤与通过口径随之变化 → 立即递增 global
  // data revision（2026-10-11 复审问题 8；与题目/策略路径共用同一入口）。
  await bumpProjectionRevision(db, globalScopeKey());

  await enqueueSearchIndexTask("contest", id, "delete", db);
}
