import { getBuiltinOiCostProfile } from "../../problems/types/oi-cost-profile.ts";
import { isOiRuntimeConfig } from "../../problems/types/runtime-config.ts";
import {
  buildJudgeTask,
  type BuildJudgeTaskInput,
  EVALUATION_PROTOCOL_VERSION,
  type JudgeTask,
  type JudgeTaskKind,
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
 * - 正式提交使用 `attempt_id`；自测使用显式 `self_test_run_id`；没有持久尝试记录的
 *   兼容调用才生成随机运行 ID，生产队列门禁会拒绝缺少正式尝试标识的消息；
 * - `problem_version_id` 仅在**已知**时下发（迁移期存量题目无版本）；
 * - `evaluation_protocol_version = 3`，judge 回显 task_kind、对应运行标识与
 *   `result_kind`。
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
  const taskKind: JudgeTaskKind = input.task_kind ?? "submission";
  const runId = taskKind === "self_test"
    ? input.self_test_run_id ?? input.run_id ?? crypto.randomUUID()
    : input.attempt_id ?? input.run_id ?? crypto.randomUUID();
  return buildJudgeTask({
    ...input,
    task_kind: taskKind,
    ...(taskKind === "self_test" ? { self_test_run_id: runId } : {}),
    // 初次尝试也必须显式下发 sequence=0；协议 v2 结果拒绝缺失的序列号。
    rejudge_seq: input.rejudge_seq ?? 0,
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
