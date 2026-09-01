/**
 * Submissions CRUD（PR-3 拆分）。
 *
 * 包含：
 * - listSubmissions（分页 + 筛选 + 队列位置查询）
 * - createSubmission（创建提交并推送到 MQ）
 * - getSubmission（详情，按权限裁剪 code/output/details）
 * - deleteSubmission
 *
 * 重测相关（rejudgeSubmission / rejudgeProblemSubmissions）在
 * submissions-rejudge.ts；评测结果写回（saveEvaluationResult / updateSubmissionStatus）
 * 在 submissions-result.ts。
 *
 * ## 关于本文件中的 `as unknown as ReturnType<typeof eq>` 模式
 *
 * PR-5 评审指出这些 cast 模式（line 107, 114, 126 等）属于类型边界合理使用，
 * 不抽取为 `unwrapRows` helper。原因：
 *
 * 1. `unwrapRows` 处理的是 `db.execute()` 的"返回值"，即 `T[] | { rows: T[] }`
 *    这种**整张表**的形态
 * 2. 本文件中的 `or(...)` / `ilike(...)` 是**单条 SQL 片段**，返回值是
 *    `SQL | SQL<unknown>`，与 unwrapRows 的契约不匹配
 * 3. 强行统一会让类型推导从 SQL 条件表达式退化为 `SQL`，丢失 schema 类型信息
 *
 * 真正的统一方案需 Drizzle 官方提供 `SQL<T>` 与 `SQL` 的统一类型，
 * 目前没有。如未来支持，迁移路径：把所有 `as unknown as ReturnType<typeof eq>`
 * 替换为直接的 `SQL<boolean>` 注解。
 *
 * 风险：每个 `as unknown as` 都是一个潜在的运行时类型漂移点。当前文件所有
 * 此类 cast 都对应 Drizzle 在 LEFT JOIN 条件下 `or`/`ilike` 返回的
 * `SQL<unknown>`，与等价的 `eq()` 返回 `SQL<boolean>` 兼容。
 */

import { and, eq, gte, ilike, isNull, lte, or, sql } from "drizzle-orm";
import {
  evaluationResults,
  problems,
  submissions,
  users,
} from "../../../../db/schema.ts";
import {
  AppError,
  BadRequestError,
  NotFoundError,
} from "../../../../lib/errors.ts";
import { getDb } from "../../../../db/connection.ts";
import { checkPermission } from "../../../../lib/permissions.ts";
import {
  generatePublicId,
  isPublicId,
  isUuid,
} from "../../../../lib/public-id.ts";
import {
  isRetryableJudgeQueueError,
  pushJudgeTask,
} from "../../../../mq/producer.ts";
import { validateJudgeImageWithKind } from "../../../../services/judge-images.ts";
import { assertContestSubmissionLimit } from "../../../contest/index.ts";
import { getStorageProvider } from "../../../../lib/storage/mod.ts";
import { getPendingQueueSnapshot, getSubmissionQueueStatus } from "../queue.ts";
import { buildJudgeTaskLlm } from "../../../../lib/llm-token.ts";
import { buildJudgeTaskLlmForProvider } from "../../../../lib/llm-token.ts";
import { getUserLlmProvider } from "../../../gateway/index.ts";
import type { LlmConfig, RuntimeConfig } from "../../../../types/problems.ts";
import type {
  JudgeTask,
  JudgeTaskLlm,
  SubmissionStatus,
} from "../../../../types/index.ts";
import type { Context } from "hono";
import { LANGUAGE_EXT_MAP } from "../../../../types/index.ts";
import { Channels, publishSseEvent } from "../../../../lib/event-bus.ts";
import type {
  ListSubmissionsParams,
  ListSubmissionsResult,
  SubmissionDetail,
  SubmissionEvaluationDetails,
  SubmissionInput,
  SubmissionListItem,
  SubmissionResponse,
} from "./submissions-types.ts";
import { logger } from "../../../../lib/logging.ts";

/**
 * 详情接口返回的 result.output 最大长度（字节近似）。
 *
 * 评测脚本 stdout 可能包含大量测试点详情，单次响应过大影响
 * 移动端加载与序列化性能。原始 output 仍完整保存在 DB 中，
 * 本截断仅作用于 API 响应层。
 *
 * 修复 issue 64 评论 §5.1。
 */
const MAX_OUTPUT_LENGTH = 8 * 1024;

/**
 * 解析 details 字段。
 * 数据库中以 JSON 字符串存储，解析为对象返回。
 */
function parseDetails(raw: string | null): SubmissionEvaluationDetails | null {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as SubmissionEvaluationDetails;
  } catch {
    return null;
  }
}

/**
 * 将评测结果状态归一化为提交状态：只保留 finished / error。
 * 旧数据中的 Accepted / WrongAnswer 等按分数制语义映射（兼容历史数据）。
 */
function normalizeResultStatus(status: string | null): string | null {
  if (!status) return null;
  if (
    status === "error" || status === "SystemError" ||
    status === "TimeLimitExceeded" || status === "MemoryLimitExceeded" ||
    status === "RuntimeError"
  ) {
    return "error";
  }
  return "finished";
}

/**
 * 查询提交列表（分页 + 筛选）。
 *
 * 使用 LEFT JOIN 一次获取提交、题目、评测结果，避免 N+1。
 * 不返回 code 字段（源代码仅在详情接口返回）。
 */
export async function listSubmissions(
  params: ListSubmissionsParams,
): Promise<ListSubmissionsResult> {
  const db = getDb();
  const {
    userId,
    contestId,
    problemId,
    problemSearch,
    submissionId,
    userSearch,
    language,
    status,
    from,
    to,
    excludeContest,
    page,
    perPage,
  } = params;

  // 动态构建筛选条件（仅对提供的参数添加条件）
  const conditions: ReturnType<typeof eq>[] = [];

  if (userId) conditions.push(eq(submissions.user_id, userId));
  if (contestId) conditions.push(eq(submissions.contest_id, contestId));
  if (excludeContest) {
    conditions.push(
      isNull(submissions.contest_id) as unknown as ReturnType<typeof eq>,
    );
  }
  if (problemId) conditions.push(eq(submissions.problem_id, problemId));
  if (language) conditions.push(eq(submissions.language, language));
  if (status) {
    conditions.push(eq(submissions.status, status as SubmissionStatus));
  }
  if (from) conditions.push(gte(submissions.created_at, from));
  if (to) conditions.push(lte(submissions.created_at, to));

  // problemSearch: problem_id 精确匹配 OR problems.title ILIKE 模糊搜索
  if (problemSearch) {
    conditions.push(
      or(
        eq(submissions.problem_id, problemSearch),
        ilike(problems.title, `%${problemSearch}%`),
      ) as unknown as ReturnType<typeof eq>,
    );
  }

  // submissionId: submissions.id ILIKE 前缀匹配
  if (submissionId) {
    conditions.push(
      ilike(submissions.id, `${submissionId}%`) as unknown as ReturnType<
        typeof eq
      >,
    );
  }

  // userSearch: users.username ILIKE OR submissions.user_id 前缀匹配
  if (userSearch) {
    conditions.push(
      or(
        ilike(users.username, `%${userSearch}%`),
        ilike(submissions.user_id, `${userSearch}%`),
      ) as unknown as ReturnType<typeof eq>,
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // COUNT 总数（需 LEFT JOIN problems 以支持 problemSearch，users 以支持 userSearch）
  let countQuery = db
    .select({ total: sql<number>`count(*)` })
    .from(submissions)
    .leftJoin(problems, eq(submissions.problem_id, problems.id));
  // userSearch 需要关联 users 表
  if (userSearch) {
    countQuery = countQuery.leftJoin(users, eq(submissions.user_id, users.id));
  }
  const [countRow] = await countQuery.where(where);

  const total = Number(countRow?.total ?? 0);

  // 无数据时提前返回，避免无效查询
  if (total === 0) {
    return { data: [], total: 0 };
  }

  const offset = (page - 1) * perPage;

  // 数据查询：LEFT JOIN problems + evaluation_results（+ users 当需要 userSearch 时）
  let dataQuery = db
    .select({
      id: submissions.id,
      public_id: submissions.public_id,
      user_id: submissions.user_id,
      problem_id: submissions.problem_id,
      contest_id: submissions.contest_id,
      language: submissions.language,
      file_name: submissions.file_name,
      status: submissions.status,
      created_at: submissions.created_at,
      judge_started_at: submissions.judge_started_at,
      judge_finished_at: submissions.judge_finished_at,
      problem_title: problems.title,
      result_status: evaluationResults.status,
      result_score: evaluationResults.score,
      result_time_ms: evaluationResults.time_ms,
      result_memory_kb: evaluationResults.memory_kb,
    })
    .from(submissions)
    .leftJoin(problems, eq(submissions.problem_id, problems.id))
    .leftJoin(
      evaluationResults,
      eq(evaluationResults.submission_id, submissions.id),
    );
  if (userSearch) {
    dataQuery = dataQuery.leftJoin(
      users,
      eq(submissions.user_id, users.id),
    );
  }
  const rows = await dataQuery.where(where)
    .orderBy(sql`${submissions.created_at} DESC`)
    .offset(offset)
    .limit(perPage);

  // 仅当存在无结果的 in-progress 提交时才查 Redis 队列
  // （避免每次列表请求都 LRANGE 整个队列）
  const hasInProgress = rows.some((r) => !r.result_status);
  let pendingPosMap: Map<string, number> | null = null;
  let queueLength: number | null = null;
  if (hasInProgress) {
    try {
      const snapshot = await getPendingQueueSnapshot();
      const pendingIds = snapshot.ids;
      queueLength = snapshot.length;
      // LRANGE 返回最新优先（LPUSH），pendingIds.length - idx
      // 使队列位置从 1（下个出队）递增；积压时 snapshot 已回退全量
      pendingPosMap = new Map(
        pendingIds.map((id, idx) => [id, pendingIds.length - idx]),
      );
    } catch {
      // Redis 不可用时，pendingPosMap 保持 null，所有未完成提交视为"评测中"
    }
  }

  const data: SubmissionListItem[] = rows.map((row) => {
    const hasResult = !!row.result_status;
    const queue_position = !hasResult && pendingPosMap
      ? (pendingPosMap.get(row.id) ?? null)
      : null;
    return {
      id: row.id,
      public_id: row.public_id,
      user_id: row.user_id,
      problem_id: row.problem_id,
      contest_id: row.contest_id,
      language: row.language,
      file_name: row.file_name,
      status: row.status,
      created_at: row.created_at,
      judge_started_at: row.judge_started_at ?? null,
      judge_finished_at: row.judge_finished_at ?? null,
      queue_position,
      queue_length: !hasResult ? queueLength : null,
      problem: {
        id: row.problem_id,
        title: row.problem_title ?? "",
      },
      result: row.result_status
        ? {
          status: normalizeResultStatus(row.result_status) ?? "finished",
          score: row.result_score ?? 0,
          time_ms: row.result_time_ms,
          memory_kb: row.result_memory_kb,
        }
        : null,
    };
  });

  return { data, total };
}

/**
 * 创建提交记录并推送到评测队列。
 *
 * @throws {NotFoundError} 题目不存在
 */
export async function createSubmission(
  userId: string,
  input: SubmissionInput,
  contestId?: string,
): Promise<SubmissionResponse> {
  const db = getDb();
  if (contestId && input.contest_id && contestId !== input.contest_id) {
    throw new BadRequestError("竞赛 ID 不一致");
  }
  const resolvedContestId = contestId ?? input.contest_id ?? null;

  // 比赛内每道题提交次数上限（含 error 计数）
  if (resolvedContestId) {
    await assertContestSubmissionLimit(
      resolvedContestId,
      userId,
      input.problem_id,
    );
  }

  // 行级锁 + 读取最新题目配置（避免 admin 在提交期间清空 runtime_config 导致竞态）
  const lockedRows = await db
    .select()
    .from(problems)
    .where(eq(problems.id, input.problem_id))
    .for("update")
    .limit(1);
  if (lockedRows.length === 0) {
    throw new NotFoundError("题目不存在");
  }
  const problem = lockedRows[0];

  // artifact 题目必须走 multipart zip 上传，拒绝 JSON 代码提交
  if (problem.submission_mode === "artifact") {
    throw new BadRequestError("该题目要求上传 zip 产物");
  }

  // 验证语言（与 LANGUAGE_EXT_MAP 键集保持一致）
  const supportedLanguages = Object.keys(LANGUAGE_EXT_MAP);
  if (!supportedLanguages.includes(input.language)) {
    throw new BadRequestError(`不支持的语言: ${input.language}`);
  }

  // 生成文件默认名：优先使用 LANGUAGE_EXT_MAP
  const fileName = input.file_name || LANGUAGE_EXT_MAP[input.language] ||
    "main.txt";

  // 创建提交记录并推送到评测队列（在同一个 try 块中保证一致性）
  const id = crypto.randomUUID();
  const publicId = generatePublicId("sub");
  const now = new Date().toISOString();

  // 获取支持包 download URL
  let download_url: string | undefined;
  if (problem.support_package_storage_url) {
    try {
      const storage = await getStorageProvider();
      download_url = await storage.downloadUrl(
        problem.support_package_storage_url,
      );
    } catch (err) {
      logger.error("获取支持包 download URL 失败", {
        storage_url: problem.support_package_storage_url,
        err,
      });
      // 支持包获取失败不阻塞提交，但会跳过支持包
    }
  }

  // ── 使用 runtime_config（双容器模式）──
  // 校验 evaluator/solution image + kind（spec §4 final gate）
  const runtimeConfig = problem.runtime_config as
    | RuntimeConfig
    | null
    | undefined;

  if (!runtimeConfig) {
    throw new AppError(
      "题目缺少 runtime_config 配置，无法评测",
      500,
      "RUNTIME_CONFIG_MISSING",
    );
  }

  // 防御性 final gate：校验双容器镜像 + kind
  await validateJudgeImageWithKind(
    runtimeConfig.evaluator.image,
    "evaluator",
  );
  await validateJudgeImageWithKind(
    runtimeConfig.solution.image,
    "solution",
  );

  let llmTask: JudgeTaskLlm | undefined;
  const llmConfig = problem.llm_config as LlmConfig | null;
  if (llmConfig) {
    llmTask = await buildJudgeTaskLlm(
      llmConfig,
      id,
      input.problem_id,
      userId,
      runtimeConfig,
    );
  }
  let userLlmTask: JudgeTaskLlm | undefined;
  if (input.llm_provider_config_id) {
    const provider = await getUserLlmProvider(
      userId,
      input.llm_provider_config_id,
    );
    if (!provider.enabled) {
      throw new BadRequestError(
        "用户模型配置已停用",
        "BYOK_CONFIG_UNAVAILABLE",
      );
    }
    userLlmTask = await buildJudgeTaskLlmForProvider(
      provider.id,
      provider.model,
      id,
      input.problem_id,
      userId,
      runtimeConfig,
    );
  }

  const task: JudgeTask = {
    submission_id: id,
    problem_id: input.problem_id,
    runtime_config: runtimeConfig,
    download_url,
    language: input.language,
    code: input.code,
    file_name: fileName,
    ...(llmTask ? { llm: llmTask } : {}),
    ...(userLlmTask ? { user_llm: userLlmTask } : {}),
  };

  try {
    await db.insert(submissions).values({
      id,
      public_id: publicId,
      user_id: userId,
      problem_id: input.problem_id,
      contest_id: resolvedContestId,
      language: input.language,
      code: input.code,
      file_name: fileName,
      llm_provider_config_id: input.llm_provider_config_id,
      status: "pending",
      created_at: now,
    });
  } catch (dbErr) {
    logger.error("提交记录插入失败", { err: dbErr });
    throw new AppError(
      "提交失败：数据库写入错误，请稍后重试",
      500,
      "SUBMISSION_DB_ERROR",
    );
  }

  try {
    await pushJudgeTask(task);
    // 入队成功后立即更新状态为 judging。
    // 条件更新：极端竞态下结果可能已先落库，不能把 finished 覆盖回 judging。
    await db.update(submissions).set({ status: "judging" }).where(
      and(eq(submissions.id, id), eq(submissions.status, "pending")),
    );

    // 写入 SSE 事件日志并发布队列变更事件
    await publishSseEvent(Channels.queue, { type: "queue:changed" });
    if (resolvedContestId) {
      await publishSseEvent(
        Channels.contestSubmission(resolvedContestId),
        {
          type: "contest:submission:created",
          contest_id: resolvedContestId,
          submission_id: id,
          user_id: userId,
          problem_id: input.problem_id,
        },
      );
    }
  } catch (mqErr) {
    logger.error("评测任务推送失败", { submission_id: id, err: mqErr });
    if (!isRetryableJudgeQueueError(mqErr)) {
      // 永久错误（如消息超过大小限制）直接置为 error，避免 sweeper 无限重试成永久 pending。
      await db.update(submissions)
        .set({
          status: "error",
          judge_finished_at: new Date().toISOString(),
        })
        .where(eq(submissions.id, id));
    }
    // NOJ-067：DB 写入与 LPUSH 无法事务化；瞬时失败保留 pending，
    // 由 mq/sweeper.ts 按超时恢复，避免永久 Pending 孤儿。
    throw new AppError(
      "提交失败：评测队列暂时不可用，请稍后重试",
      500,
      "SUBMISSION_QUEUE_ERROR",
    );
  }

  return {
    id,
    public_id: publicId,
    user_id: userId,
    problem_id: input.problem_id,
    contest_id: resolvedContestId,
    language: input.language,
    code: input.code,
    file_name: fileName,
    status: "judging",
    created_at: now,
  };
}

/**
 * 根据 ID 查询提交记录。
 *
 * 权限模型（issue: 评测详情公开访问分级）：
 * - 基础数据（题号、状态、时间、内存、得分等）：所有访问者可见
 * - 详细内容（源代码、评测输出、用例级详情）：仅 owner 或 admin 可见
 *
 * @param id 提交 ID
 * @param viewerId 当前查看者的 userId；undefined/null 表示匿名访问
 * @param viewerRole 当前查看者的角色；'admin' 时跳过所有权校验
 *
 * @throws {NotFoundError} 提交不存在
 */
export async function getSubmission(
  id: string,
  viewerId?: string | null,
  viewerRole?: string | null,
  c?: Context,
): Promise<SubmissionDetail> {
  const db = getDb();

  const rows = await db
    .select()
    .from(submissions)
    .where(eq(submissions.id, id))
    .limit(1);

  if (rows.length === 0) {
    throw new NotFoundError("提交不存在");
  }

  const row = rows[0];

  // 权限判断：仅 owner 或 admin 可看 code/output/details
  // 注意：基础数据（题号/状态/时间等）对所有访问者公开，不在这里做"非所有者 404"的拦截
  const isOwner = !!(c?.var.userId ?? viewerId) &&
    row.user_id === (c?.var.userId ?? viewerId);
  // 实时权限查询（submission:read_all，admin:full_access 通配）
  const isAdmin = c
    ? await checkPermission(c, "submission:read_all")
    : viewerRole === "admin";
  const canSeeDetails = isOwner || isAdmin;

  // 类 Kaggle 赛制不隐藏进行中的评测结果（实时榜按排名接口权限控制）
  const hideResult = false;

  // 查询评测结果
  const resultRows = await db
    .select()
    .from(evaluationResults)
    .where(eq(evaluationResults.submission_id, id))
    .limit(1);

  const result = !hideResult && resultRows.length > 0
    ? (() => {
      const rawOutput = resultRows[0].output ?? "";
      // API 层截断：原始 output 完整保留在 DB，仅响应层控制大小
      const output_truncated = rawOutput.length > MAX_OUTPUT_LENGTH;
      // 仅 owner/admin 返回 output（截断），其他访问者得到 null
      const output = canSeeDetails
        ? (output_truncated ? rawOutput.slice(0, MAX_OUTPUT_LENGTH) : rawOutput)
        : null;
      // 仅 owner/admin 解析 details JSON，其他访问者得到 null
      const details = canSeeDetails
        ? parseDetails(resultRows[0].details)
        : null;
      return {
        status: normalizeResultStatus(resultRows[0].status) ?? "finished",
        score: resultRows[0].score,
        output,
        output_truncated: canSeeDetails ? output_truncated : null,
        time_ms: resultRows[0].time_ms,
        memory_kb: resultRows[0].memory_kb,
        details,
      };
    })()
    : null;

  // 查询队列状态信息（排队位置、时间戳）
  // getSubmissionQueueStatus 已实现三态权限：未登录 + owner + admin 可见，登录非 owner 不可见
  // Redis 不可用时内部静默失败，返回 null 时间戳回退至 DB 值
  const queueStatus = await getSubmissionQueueStatus(
    id,
    viewerId ?? undefined,
    viewerRole ?? undefined,
  );

  return {
    id: row.id,
    public_id: row.public_id,
    user_id: row.user_id,
    problem_id: row.problem_id,
    contest_id: row.contest_id,
    language: row.language,
    code: canSeeDetails ? row.code : null,
    file_name: row.file_name,
    status: row.status,
    created_at: row.created_at,
    result,
    queue_position: queueStatus?.queue_position ?? null,
    queue_length: queueStatus?.queue_length ?? null,
    judge_started_at: queueStatus?.judge_started_at ?? row.judge_started_at ??
      null,
    judge_finished_at: queueStatus?.judge_finished_at ??
      row.judge_finished_at ?? null,
  };
}

/**
 * 将 UUID 或 public_id 解析为内部提交 UUID；其它格式按主键兜底。
 */
export async function resolveSubmissionId(value: string): Promise<string> {
  const db = getDb();
  if (isUuid(value)) return value;
  if (isPublicId(value, "sub")) {
    const rows = await db.select({ id: submissions.id }).from(submissions)
      .where(eq(submissions.public_id, value)).limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundError("提交不存在");
    return row.id;
  }
  const byId = await db.select({ id: submissions.id }).from(submissions)
    .where(eq(submissions.id, value)).limit(1);
  if (!byId[0]) throw new NotFoundError("提交不存在");
  return byId[0].id;
}

/**
 * 删除提交。
 *
 * 仅做级联 delete（CASCADE 已覆盖 evaluation_results），不清理 Redis 队列。
 *
 * @throws {NotFoundError} 提交不存在
 */
export async function deleteSubmission(id: string): Promise<void> {
  const db = getDb();

  const existing = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(eq(submissions.id, id))
    .limit(1);

  if (existing.length === 0) {
    throw new NotFoundError("提交不存在");
  }

  await db.delete(submissions).where(eq(submissions.id, id));
}
