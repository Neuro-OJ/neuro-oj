import {
  getBuiltinOiCostProfile,
  isOiRuntimeConfig,
} from "../../catalog/index.ts";
import {
  buildJudgeTask,
  type BuildJudgeTaskInput,
  EVALUATION_PROTOCOL_VERSION,
  type JudgeTask,
} from "../types/index.ts";

/** 正式评测任务的封套输入（Handbook §5.5）。 */
export interface PrepareJudgeTaskInput extends BuildJudgeTaskInput {
  /**
   * 本次执行的评测尝试 ID（`evaluation_attempts.id`）。
   *
   * **正式提交必传**：`run_id` 与之一致，结果回填才能落到正确的尝试上。
   * 自测/演练等没有尝试记录的任务不传，OI 任务退回随机 ID（进度/取消键仍需唯一）。
   */
  attempt_id?: string;
}

/**
 * 构造评测任务（唯一入口）。
 *
 * 版本化封套规则（Handbook §5.5）：
 * - `run_id = attempt_id`（正式提交）；无尝试时 OI 任务生成随机 ID 供进度/取消使用；
 * - `problem_version_id` 仅在**已知**时下发（迁移期存量题目无版本）；
 * - `evaluation_protocol_version = 2`，judge 回显该版本号与 `result_kind`。
 *
 * WASM 任务只绑定内置标准，禁止注入本机或题目自定义成本。
 */
export function prepareJudgeTask(
  input: PrepareJudgeTaskInput,
): JudgeTask {
  const profile = isOiRuntimeConfig(input.runtime_config) &&
      input.runtime_config.backend === "wasm"
    ? getBuiltinOiCostProfile()
    : undefined;
  const runId = input.attempt_id ??
    (isOiRuntimeConfig(input.runtime_config) ? crypto.randomUUID() : undefined);
  return buildJudgeTask({
    ...input,
    ...(runId ? { run_id: runId } : {}),
    ...(input.problem_version_id
      ? { problem_version_id: input.problem_version_id }
      : {}),
    evaluation_protocol_version: EVALUATION_PROTOCOL_VERSION,
    runtime_config: isOiRuntimeConfig(input.runtime_config)
      ? { ...input.runtime_config, scoring_version: 2 }
      : input.runtime_config,
    oi_cost_profile: profile,
  });
}
