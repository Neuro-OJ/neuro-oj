import { isOiRuntimeConfig } from "../../catalog/types/runtime-config.ts";
import type { OiCostProfile } from "../../catalog/types/oi-cost-profile.ts";
import {
  buildJudgeTask,
  type BuildJudgeTaskInput,
  type JudgeTask,
} from "../types/index.ts";

/** 活动成本表读取接缝：system 必须每次读取共享活动配置，禁止进程缓存。 */
export type OiCostProfileResolver = () => Promise<OiCostProfile | null>;
async function activeCostProfile(): Promise<OiCostProfile | null> {
  const system = await import("../../system/index.ts");
  const accessor =
    (system as unknown as { getActiveOiCostProfile?: OiCostProfileResolver })
      .getActiveOiCostProfile;
  return accessor ? await accessor() : null;
}
/** 业务任务先获取一致的可信成本快照，再通过唯一 wire 构造入口。 */
export async function prepareJudgeTask(
  input: BuildJudgeTaskInput,
  resolveProfile: OiCostProfileResolver = activeCostProfile,
): Promise<JudgeTask> {
  const profile = isOiRuntimeConfig(input.runtime_config) &&
      input.runtime_config.backend === "wasm"
    ? await resolveProfile()
    : undefined;
  return buildJudgeTask({ ...input, oi_cost_profile: profile ?? undefined });
}
