/**
 * prediction 提交服务（预测结果文件提交）。
 *
 * 与 artifact 提交共用「上传文件 → 版本绑定 → 评测尝试 → 入队」流程
 * （`createUploadedSubmission`），差异只在：
 * - 提交物是**单个数据文件**（非 zip），文件名形态、扩展名与魔数经
 *   `prediction-format.ts` 校验（禁止 pickle 类格式）；
 * - 评测只创建 Evaluator 容器（`runtime_config` 可省略 `solution`）；
 * - 复用 `submissions.artifact_storage_url` 列存放预测文件 URL，继承产物的
 *   「保留到提交删除 / 可重测 / 上传补偿 / 相似度排除」生命周期。
 *
 * @module
 */

import type { SubmissionResponse } from "./submissions-types.ts";
import type { DomainExecutionRequest } from "../workspace-execution.ts";
import type { DomainEvaluationAdmissionPlan } from "../../contracts/admission.ts";
import {
  createUploadedSubmission,
  type UploadedSubmissionInput,
  type UploadedSubmissionSpec,
} from "./artifact-submissions.ts";
import {
  predictionFileExtension,
  validatePredictionFile,
  validatePredictionFileName,
} from "./prediction-format.ts";

/** prediction 提交的输入（单文件流）。 */
export type PredictionSubmissionInput = UploadedSubmissionInput;

const PREDICTION_SPEC: UploadedSubmissionSpec = {
  mode: "prediction",
  modeMismatchMessage: "该题目不支持 prediction 提交",
  validateFileName: validatePredictionFileName,
  // 扩展名白/黑名单 + 魔数（含 pickle 协议头）在上传前基于首块完成。
  validateHead: validatePredictionFile,
  storageExtension: predictionFileExtension,
  contentType: "application/octet-stream",
};

/**
 * 创建 prediction 提交。
 *
 * @param userId 提交用户
 * @param input problem_id / file_name / file_stream / contest_id / version_id
 * @param contestId 路由层显式竞赛 ID（可选）
 * @param isAdmin 是否管理员（访问解析用）
 */
export function createPredictionSubmission(
  userId: string,
  input: PredictionSubmissionInput,
  contestId?: string,
  isAdmin = false,
  domainRequest?: DomainExecutionRequest,
  admissionPlan?: DomainEvaluationAdmissionPlan,
): Promise<SubmissionResponse> {
  return createUploadedSubmission(
    PREDICTION_SPEC,
    userId,
    input,
    contestId,
    isAdmin,
    domainRequest,
    admissionPlan,
  );
}
