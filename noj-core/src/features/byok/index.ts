/**
 * 用户自带模型（BYOK）功能对外出口（见 README.md）。
 *
 * 评测侧的 BYOK 凭据签发在 `modules/platform/gateway/services/llm-token.ts`
 * （`buildJudgeTaskLlm` 的 `byok` 选项），本切片只负责本人配置的读写与测试。
 */
import { defineFeature } from "../../shared/feature.ts";
import { byokRouter } from "./routes.ts";

export const feature = defineFeature({
  name: "byok",
  router: byokRouter,
});

export type { ByokState, ByokTestResult } from "./service.ts";
