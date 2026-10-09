import {
  getBuiltinOiCostProfile,
  isOiRuntimeConfig,
} from "../../catalog/index.ts";
import {
  buildJudgeTask,
  type BuildJudgeTaskInput,
  type JudgeTask,
} from "../types/index.ts";
/** WASM 任务只绑定内置标准，禁止注入本机或题目自定义成本。 */
export function prepareJudgeTask(
  input: BuildJudgeTaskInput,
): JudgeTask {
  const profile = isOiRuntimeConfig(input.runtime_config) &&
      input.runtime_config.backend === "wasm"
    ? getBuiltinOiCostProfile()
    : undefined;
  return buildJudgeTask({
    ...input,
    ...(isOiRuntimeConfig(input.runtime_config)
      ? { run_id: crypto.randomUUID() }
      : {}),
    runtime_config: isOiRuntimeConfig(input.runtime_config)
      ? { ...input.runtime_config, scoring_version: 2 }
      : input.runtime_config,
    oi_cost_profile: profile,
  });
}
