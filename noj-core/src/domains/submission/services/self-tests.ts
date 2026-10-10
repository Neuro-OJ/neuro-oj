/**
 * 代码自测服务（issue #221）。
 *
 * 自测与正式提交走完全相同的评测流程，但结果只写入独立的 `self_tests` 表，
 * 不参与统计/榜单/AC 活动。
 */

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import { problems, selfTests } from "./../../../shared/db/schema.ts";
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
} from "./../../../shared/base/errors.ts";
import { checkPermission } from "./../../identity/index.ts";
import { getStorageProvider } from "./../../system/index.ts";
import { getRedis } from "../../../shared/mq/connection.ts";
import { isRetryableJudgeQueueError, pushJudgeTask } from "../mq/producer.ts";
import { validateJudgeImageWithKind } from "../../system/index.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["noj", "submission"]);
import { Channels, publishSseEvent } from "./../../../shared/sse/event-bus.ts";
import type { Context } from "hono";
import { LANGUAGE_EXT_MAP } from "../types/index.ts";
import type { JudgeResult } from "../types/index.ts";
import { prepareJudgeTask } from "./prepare-judge-task.ts";
import {
  assertVersionAcceptsSubmission,
  resolveSubmissionVersion,
} from "./versioning/submission-version.ts";
import { evaluateProblemAccess } from "./../../catalog/index.ts";
import { buildOiSelfTestPackage } from "../../catalog/index.ts";
import {
  isOiRuntimeConfig,
  type ProblemRuntimeConfig,
} from "./../../catalog/index.ts";
import {
  SELF_TEST_ID_PREFIX,
  type SelfTestDetail,
  type SelfTestInput,
  type SelfTestResponse,
  type SelfTestStatus,
} from "./../types/self-tests.ts";

/** 详情接口返回的 output 最大长度（字节近似），与正式提交一致。 */
const MAX_OUTPUT_LENGTH = 8 * 1024;

/** 取消 OI 自测；先持久化共享取消信号，再锁住终态，保留已有进度结果。 */
export async function cancelSelfTest(id: string, c: Context): Promise<void> {
  const detail = await getSelfTest(id, c);
  if (!["pending", "judging"].includes(detail.status)) return;
  const db = getDb();
  const [row] = await db.select().from(selfTests).where(eq(selfTests.id, id));
  if (!row.judge_run_id) {
    throw new BadRequestError("此自测使用旧协议，不支持取消");
  }
  await getRedis().set(
    `noj:judge:cancel:${id}:${row.judge_run_id}`,
    "1",
    "EX",
    3600,
  );
  await db.update(selfTests).set({
    status: "cancelled",
    result_status: "cancelled",
    judge_finished_at: new Date().toISOString(),
  })
    .where(
      and(
        eq(selfTests.id, id),
        eq(selfTests.judge_run_id, row.judge_run_id),
        inArray(selfTests.status, ["pending", "judging"]),
      ),
    );
  await publishSseEvent(Channels.submission(id), {
    type: "submission:updated",
    id,
  });
}

/** 解析 details 字段（数据库存 JSON 字符串）。 */
function parseDetails(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * 创建自测并推入评测队列。
 *
 * @throws {NotFoundError} 题目不存在
 * @throws {BadRequestError} 语言不支持 / 客观题不支持自测 / 题目缺少 runtime_config
 */
export async function createSelfTest(
  userId: string,
  problemId: string,
  input: SelfTestInput,
  isAdmin = false,
): Promise<SelfTestResponse> {
  const db = getDb();

  // 读取最新题目配置；不依赖行级锁（自测是只读快照，入队前若 config 变化由 judge 侧兜底）
  const rows = await db
    .select()
    .from(problems)
    .where(eq(problems.id, problemId))
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError("题目不存在");
  }
  const problem = rows[0];

  // 统一访问解析：自测不允许携带竞赛上下文，private 题仅 owner/admin；
  // 被公开赛保密的题目同样只有 owner/管理员可自测。
  const { result: access } = await evaluateProblemAccess(problem, {
    viewerId: userId,
    isAdmin,
  });
  if (!access.allowed) {
    // 被未结束公开赛保密的题目对外一律"不存在"（面 1.4 审计 F-03）：
    // 若此处统一 403，则 403（保密题）与 404（题目不存在）的差异本身就是
    // **存在性预言机**——display_id 可枚举，攻击者据此即可在赛前确认某题已被
    // 某场未开始的公开赛收编。详情/模板/支持包路径都已是 404，自测路径曾漏掉。
    if (access.mode === "contest-secret") {
      throw new NotFoundError("题目不存在");
    }
    throw new ForbiddenError("无权对该题目自测");
  }

  if (problem.is_objective) {
    throw new BadRequestError("客观题不支持代码自测");
  }

  // 验证语言（与正式提交保持一致）
  const supportedLanguages = Object.keys(LANGUAGE_EXT_MAP);
  if (!supportedLanguages.includes(input.language)) {
    throw new BadRequestError(`不支持的语言: ${input.language}`);
  }

  // 生成文件默认名
  const fileName = input.file_name || LANGUAGE_EXT_MAP[input.language] ||
    "main.txt";

  // 获取支持包 download URL
  let download_url: string | undefined;
  if (problem.support_package_storage_url) {
    try {
      const storage = await getStorageProvider();
      download_url = await storage.downloadUrl(
        problem.support_package_storage_url,
      );
    } catch (err) {
      logger.error("自测获取支持包 download URL 失败", {
        storage_url: problem.support_package_storage_url,
        err,
      });
      // 获取失败不阻塞自测，但会跳过支持包
    }
  }

  // 自测版本解析（Handbook §4.2）：与正式提交同一口径——显式版本逐字生效，
  // 未指定时按有效策略取默认作答版本；存量未版本化题目回退题目投影。
  const versionResolution = await resolveSubmissionVersion(problemId, {
    requestedVersionId: input.version_id,
    latestVersionId: problem.latest_version_id,
  });
  let selfTestVersionId: string | null = null;
  let versionRuntimeConfig: ProblemRuntimeConfig | null = null;
  if (versionResolution.kind === "known") {
    selfTestVersionId = versionResolution.version.version_id;
    const content = versionResolution.version.content;
    assertVersionAcceptsSubmission(content, {
      language: input.language,
      submissionMode: problem.submission_mode as "code" | "artifact",
    });
    if (content.kind === "ai" || content.kind === "oi") {
      versionRuntimeConfig = content.runtime_config;
    }
  }

  // 双容器 runtime_config 校验：已版本化时**以版本内容为准**（题目投影只是最新版
  // 的影子，版本才是判卷事实源）
  const runtimeConfig = (versionRuntimeConfig ??
    problem.runtime_config) as
      | ProblemRuntimeConfig
      | null
      | undefined;
  if (!runtimeConfig) {
    throw new AppError(
      "题目缺少 runtime_config 配置，无法评测",
      500,
      "RUNTIME_CONFIG_MISSING",
    );
  }

  if (isOiRuntimeConfig(runtimeConfig)) {
    if (!runtimeConfig.languages.includes(input.language as "c" | "cc")) {
      throw new BadRequestError(`该 OI 题目不支持语言: ${input.language}`);
    }
  } else {
    if (input.language === "c" || input.language === "cc") {
      throw new BadRequestError("C/C++ 自测仅适用于 judge_type=oi 的题目");
    }
    await validateJudgeImageWithKind(
      runtimeConfig.evaluator.image,
      "evaluator",
    );
    await validateJudgeImageWithKind(
      runtimeConfig.solution.image,
      "solution",
    );
  }

  const id = `${SELF_TEST_ID_PREFIX}${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  const oiSelfTest = isOiRuntimeConfig(runtimeConfig)
    ? await buildOiSelfTestPackage(
      runtimeConfig,
      problem.support_package_storage_url,
      input.cases ??
        ((problem.samples ?? []) as {
          id: string;
          input: string;
          output: string;
        }[]).map((sample) => ({
          id: sample.id,
          input: sample.input,
          expected_output: sample.output,
        })),
    )
    : undefined;
  if (!isOiRuntimeConfig(runtimeConfig) && input.cases !== undefined) {
    throw new BadRequestError("自定义用例仅用于 OI 自测");
  }
  const task = await prepareJudgeTask({
    // 自测使用独立运行标识（不是评测尝试），但仍携带版本与协议版本
    submission_id: id,
    problem_id: problemId,
    ...(selfTestVersionId ? { problem_version_id: selfTestVersionId } : {}),
    user_id: userId,
    priority: "medium",
    runtime_config: oiSelfTest?.runtime_config ?? runtimeConfig,
    download_url: oiSelfTest?.download_url ?? download_url,
    language: input.language,
    code: input.code,
    file_name: fileName,
  });

  try {
    await db.insert(selfTests).values({
      id,
      user_id: userId,
      problem_id: problemId,
      language: input.language,
      code: input.code,
      file_name: fileName,
      status: "pending",
      // 自测同样记录版本与执行快照：sweeper 据此从版本恢复（不读当前投影）
      problem_version_id: selfTestVersionId,
      task_snapshot: {
        language: input.language,
        problem_version_id: selfTestVersionId,
        judge_type: task.judge_type,
        submission_mode: problem.submission_mode,
      },
      created_at: now,
    });
  } catch (dbErr) {
    logger.error("自测记录插入失败", { err: dbErr });
    throw new AppError(
      "自测失败：数据库写入错误，请稍后重试",
      500,
      "SELF_TEST_DB_ERROR",
    );
  }

  try {
    await pushJudgeTask(task);
    // 入队成功后更新状态为 judging；条件更新避免极端竞态下覆盖终态
    await db.update(selfTests).set({
      status: "judging",
      judge_started_at: now,
    }).where(
      and(eq(selfTests.id, id), eq(selfTests.status, "pending")),
    );
    await publishSseEvent(Channels.queue, { type: "queue:changed" });
  } catch (mqErr) {
    logger.error("自测任务推送失败", { self_test_id: id, err: mqErr });
    if (!isRetryableJudgeQueueError(mqErr)) {
      await db.update(selfTests)
        .set({
          status: "error",
          judge_finished_at: new Date().toISOString(),
        })
        .where(eq(selfTests.id, id));
    }
    throw new AppError(
      "自测失败：评测队列暂时不可用，请稍后重试",
      500,
      "SELF_TEST_QUEUE_ERROR",
    );
  }

  return {
    id,
    user_id: userId,
    problem_id: problemId,
    language: input.language,
    code: input.code,
    file_name: fileName,
    status: "judging",
    created_at: now,
  };
}

/**
 * 根据 ID 查询自测详情。
 *
 * 权限：仅 owner 或 admin 可见；非 owner/admin 返回 404（不暴露自测存在）。
 */
export async function getSelfTest(
  id: string,
  c: Context,
): Promise<SelfTestDetail> {
  const db = getDb();

  const rows = await db
    .select()
    .from(selfTests)
    .where(eq(selfTests.id, id))
    .limit(1);

  if (rows.length === 0) {
    throw new NotFoundError("自测不存在");
  }

  const row = rows[0];

  // 权限：owner 或 admin 可读
  const isOwner = !!c.var.userId && row.user_id === c.var.userId;
  const isAdmin = await checkPermission(c, "submission:read_all");
  if (!isOwner && !isAdmin) {
    throw new NotFoundError("自测不存在");
  }

  const rawOutput = row.output ?? "";
  const outputTruncated = rawOutput.length > MAX_OUTPUT_LENGTH;
  const output = outputTruncated
    ? rawOutput.slice(0, MAX_OUTPUT_LENGTH)
    : rawOutput;
  const details = parseDetails(row.details);

  return {
    id: row.id,
    user_id: row.user_id,
    problem_id: row.problem_id,
    language: row.language,
    code: row.code,
    progress: row.judge_progress as
      | import("./oi-progress.ts").OiProgress
      | null,
    file_name: row.file_name,
    status: row.status as SelfTestStatus,
    result_status: row.result_status,
    score: row.score,
    output,
    output_truncated: outputTruncated,
    details,
    time_ms: row.time_ms,
    memory_kb: row.memory_kb,
    judge_started_at: row.judge_started_at,
    judge_finished_at: row.judge_finished_at,
    created_at: row.created_at,
  };
}

/**
 * 保存自测评测结果（幂等）。
 *
 * 只更新 `self_tests` 表，不触发统计缓存、榜单刷新或 AC 活动。
 */
export async function saveSelfTestResult(
  result: JudgeResult,
): Promise<boolean> {
  const db = getDb();

  const now = new Date().toISOString();
  const status: SelfTestStatus = result.status === "cancelled"
    ? "cancelled"
    : result.status === "error" || result.status === "SystemError"
    ? "error"
    : "finished";

  const outcome = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({
        status: selfTests.status,
        judge_run_id: selfTests.judge_run_id,
        judge_started_at: selfTests.judge_started_at,
      })
      .from(selfTests)
      .where(eq(selfTests.id, result.submission_id))
      .for("update")
      .limit(1);

    if (!existing) {
      logger.warn("自测不存在，忽略评测结果", {
        self_test_id: result.submission_id,
      });
      return null;
    }
    if (
      existing.judge_run_id && result.details.run_id !== existing.judge_run_id
    ) return null;

    // 已终态：忽略重复结果
    const current = existing.status as SelfTestStatus;
    if (
      current === "finished" || current === "error" || current === "cancelled"
    ) {
      logger.info("重复自测结果，跳过", {
        self_test_id: result.submission_id,
      });
      return null;
    }

    await tx
      .update(selfTests)
      .set({
        status,
        result_status: result.status,
        score: result.score,
        output: result.output,
        details: JSON.stringify(result.details),
        time_ms: result.time_ms ?? null,
        memory_kb: result.memory_kb ?? null,
        judge_started_at: existing.judge_started_at ?? now,
        judge_finished_at: now,
      })
      .where(eq(selfTests.id, result.submission_id));

    return true;
  });

  return outcome === true;
}
