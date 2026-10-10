/** 已发布版本的执行文件读取。所有提交入口及恢复链路共用，禁止读最新版投影。 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../shared/db/connection.ts";
import { problemVersionObjects } from "../../../../shared/db/schema.ts";
import { AppError } from "../../../../shared/base/errors.ts";
import { getStorageProvider } from "../../../system/index.ts";
import type { LlmConfig } from "../../../catalog/index.ts";
import { resolveLlmLimits } from "../../../gateway/index.ts";
import type { JudgeTask } from "../../types/index.ts";

/** 指定版本的支持包地址；不存在引用与后端丢失是不同情况。 */
export async function versionSupportPackageUrl(
  versionId: string,
): Promise<string | null> {
  const [ref] = await getDb().select().from(problemVersionObjects).where(and(
    eq(problemVersionObjects.version_id, versionId),
    eq(problemVersionObjects.role, "support_package"),
    eq(problemVersionObjects.path, "package.zip"),
  )).limit(1);
  return ref?.storage_url ?? null;
}

/** 重新签发下载地址，存量对象缺失时失败，不能无支持包继续评测。 */
export async function versionSupportPackageDownload(
  versionId: string,
): Promise<string | undefined> {
  const url = await versionSupportPackageUrl(versionId);
  if (!url) return undefined;
  const storage = await getStorageProvider();
  if (!(await storage.stat(url)).exists) {
    throw new AppError(
      "目标版本的支持包已缺失",
      409,
      "SUPPORT_PACKAGE_MISSING",
    );
  }
  return await storage.downloadUrl(url);
}

/** 保存实际执行参数，排除源码、短期下载地址与 token。 */
export function executionSnapshot(
  task: JudgeTask,
  llmConfig?: LlmConfig | null,
  previous?: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    language: task.language,
    problem_version_id: task.problem_version_id,
    judge_type: task.judge_type,
    runtime_config: task.runtime_config,
    ...(task.oi_cost_profile ? { oi_cost_profile: task.oi_cost_profile } : {}),
    ...(task.llm && llmConfig
      ? {
        llm_execution: previous?.llm_execution ?? {
          provider_id: task.llm.provider_id,
          model: task.llm.allowed_models[0],
          ...resolveLlmLimits(llmConfig),
        },
      }
      : {}),
  };
}
