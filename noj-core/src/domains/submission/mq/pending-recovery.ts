/** 从持久化的版本与执行快照恢复同一次运行，短期凭据仅在派发时续签。 */
import { eq } from "drizzle-orm";
import { AppError } from "../../../shared/base/errors.ts";
import { getDb } from "../../../shared/db/connection.ts";
import { evaluationAttempts } from "../../../shared/db/schema.ts";
import {
  buildOiSelfTestPackage,
  isOiRuntimeConfig,
} from "../../catalog/index.ts";
import type {
  OiSelfTestCase,
  ProblemRuntimeConfig,
} from "../../catalog/index.ts";
import { buildJudgeTaskLlm } from "../../gateway/index.ts";
import type { FrozenLlmExecution } from "../../gateway/index.ts";
import { getStorageProvider } from "../../system/index.ts";
import { prepareJudgeTask } from "../services/prepare-judge-task.ts";
import { loadPublishedVersionContent } from "../services/versioning/submission-version.ts";
import {
  scriptTemplateOf,
  versionSupportPackageDownload,
  versionSupportPackageUrl,
} from "../services/versioning/version-execution.ts";
import { resolveJudgeTaskPriority } from "../services/submissions/judge-priority.ts";
import type { PendingRecoveryRow } from "./sweeper.ts";
import { type JudgeTask, toJudgeSubmissionMode } from "../types/index.ts";

/** 版本或运行归属缺失时拒绝恢复，禁止猜测最新版。 */
export async function rebuildPendingTask(
  row: PendingRecoveryRow,
  source: "submission" | "self_test",
): Promise<JudgeTask> {
  let versionId = row.problem_version_id;
  let runId = row.judge_run_id;
  let sequence = row.rejudge_seq ?? 0;
  let snapshot = row.task_snapshot;
  if (source === "submission") {
    const [attempt] = row.active_attempt_id
      ? await getDb().select().from(evaluationAttempts).where(
        eq(evaluationAttempts.id, row.active_attempt_id),
      )
      : [];
    if (
      !attempt || attempt.submission_id !== row.id ||
      attempt.problem_id !== row.problem_id ||
      ["finished", "error", "superseded"].includes(attempt.state)
    ) {
      throw new AppError(
        "缺少可恢复的活动尝试",
        409,
        "RECOVERY_ATTEMPT_MISSING",
      );
    }
    versionId = attempt.problem_version_id;
    runId = attempt.id;
    sequence = attempt.sequence;
    snapshot = attempt.task_snapshot as Record<string, unknown> | null;
  }
  if (!versionId || !runId) {
    throw new AppError(
      "恢复缺少绑定版本或运行标识",
      409,
      "RECOVERY_VERSION_MISSING",
    );
  }
  const loaded = await loadPublishedVersionContent(row.problem_id, versionId);
  if (!loaded || loaded.content.kind === "objective") {
    throw new AppError("绑定版本无法评测", 409, "RECOVERY_VERSION_MISSING");
  }
  const content = loaded.content;
  const runtime = (snapshot?.runtime_config ??
    content.runtime_config) as ProblemRuntimeConfig;
  let downloadUrl = await versionSupportPackageDownload(versionId);
  let executionRuntime = runtime;
  if (source === "self_test" && isOiRuntimeConfig(runtime)) {
    const cases = snapshot?.self_test_cases;
    if (!Array.isArray(cases)) {
      throw new AppError("自测用例快照缺失", 409, "SELF_TEST_SNAPSHOT_MISSING");
    }
    const pack = await buildOiSelfTestPackage(
      runtime,
      await versionSupportPackageUrl(versionId),
      cases as OiSelfTestCase[],
    );
    downloadUrl = pack.download_url;
    executionRuntime = pack.runtime_config;
  }
  let artifactDownloadUrl;
  if (row.artifact_storage_url) {
    const storage = await getStorageProvider();
    if (!(await storage.stat(row.artifact_storage_url)).exists) {
      throw new AppError("产物已缺失", 409, "ARTIFACT_MISSING");
    }
    artifactDownloadUrl = await storage.downloadUrl(row.artifact_storage_url);
  }
  let llm;
  if (content.kind === "ai" && content.llm_config && source === "submission") {
    if (!snapshot?.llm_execution) {
      throw new AppError(
        "LLM 执行快照缺失，拒绝改用当前默认配置",
        409,
        "LLM_SNAPSHOT_MISSING",
      );
    }
    llm = await buildJudgeTaskLlm(
      content.llm_config,
      row.id,
      row.problem_id,
      row.user_id ?? "",
      content.runtime_config,
      {
        attemptId: runId,
        problemVersionId: versionId,
        frozen: snapshot.llm_execution as FrozenLlmExecution,
      },
    );
  }
  const priority = source === "self_test"
    ? "medium"
    : sequence > 0
    ? "low"
    : await resolveJudgeTaskPriority(row.contest_id ?? null, "submission");
  const task = prepareJudgeTask({
    run_id: runId,
    ...(source === "submission" ? { attempt_id: runId } : {}),
    problem_version_id: versionId,
    submission_id: row.id,
    problem_id: row.problem_id,
    user_id: row.user_id ?? "",
    priority,
    // 自测恒为代码；正式提交按绑定版本的提交模式恢复（发布后不可变）。
    submission_mode: source === "submission" && content.kind === "ai"
      ? toJudgeSubmissionMode(content.submission_mode)
      : "code",
    runtime_config: executionRuntime,
    download_url: downloadUrl,
    artifact_download_url: artifactDownloadUrl,
    language: row.language,
    code: row.artifact_storage_url ? "" : row.code,
    script_template: row.language === "ui"
      ? scriptTemplateOf(content)
      : undefined,
    file_name: row.file_name ?? undefined,
    rejudge_seq: sequence,
    llm,
  });
  // 平台内置成本版本也属于本次运行的事实；重投不重新解析最新版。
  if (snapshot?.oi_cost_profile) {
    task.oi_cost_profile = snapshot.oi_cost_profile as NonNullable<
      JudgeTask["oi_cost_profile"]
    >;
  }
  return task;
}
