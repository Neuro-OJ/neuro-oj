export {
  createLlmProvider,
  deleteLlmGatewayModelAlias,
  describeLlmPlatformDefaultGap,
  exportGatewayPolicySnapshot,
  getLlmPlatformDefault,
  getLlmProviderById,
  importGatewayPolicySnapshot,
  listInstanceLlmQuotas,
  listLlmGatewayModelAliases,
  listLlmGatewayModelCapabilities,
  listLlmProviders,
  listLlmQuotas,
  LlmGatewayError,
  parseLlmRevision,
  queryLlmUsage,
  readGatewayPolicy,
  readLlmGatewaySettings,
  resolveLlmGatewayExecution,
  testLlmProvider,
  updateLlmGatewaySettings,
  updateLlmProvider,
  upsertLlmGatewayModelAlias,
  upsertLlmQuota,
} from "./services/llm.ts";
export type {
  GatewayDomainModelSettings,
  GatewayModelAliasInput,
  GatewayModelAliasView,
  GatewayPolicySnapshot,
  GatewayResolvedModelSelection,
  LlmProviderInput,
  LlmProviderView,
  LlmQuotaInput,
  LlmUsageQuery,
} from "./services/llm.ts";
export {
  assertLlmLimitsWithinDefault,
  getDefaultLlmLimits,
  resolveLlmLimits,
} from "./services/llm-limits.ts";
export {
  buildJudgeTaskLlm,
  LLM_TOKEN_PROTOCOL_VERSION,
  mintEvalToken,
} from "./services/llm-token.ts";
export type { FrozenLlmExecution } from "./services/llm-token.ts";
export {
  getDomainLlmDefault,
  seedDomainLlmDefaults,
} from "./services/domain-default.ts";
export {
  addDomainLlmProvider,
  editDomainLlmProvider,
  readDomainLlmModelAliases,
  readDomainLlmProviders,
  readDomainLlmQuotas,
  readDomainLlmSettings,
  readDomainLlmUsage,
  removeDomainLlmModelAlias,
  saveDomainLlmModelAlias,
  saveDomainLlmQuota,
  saveDomainLlmSettings,
  testDomainLlmProvider,
} from "./services/domain-management.ts";
export {
  assertLlmModelsValid,
  deleteLlmModelAlias,
  isDefaultOnly,
  listLlmModelAliasCapabilities,
  listLlmModelAliases,
  listProblemsUsingAlias,
  normalizeLlmModels,
  resolveLlmModels,
  upsertLlmModelAlias,
} from "./services/llm-model-aliases.ts";
export type {
  LlmModelAlias,
  LlmModelAliasInput,
  ResolvedLlmModels,
} from "./services/llm-model-aliases.ts";
// 迁移期：供 src/features/knowledge 使用（平台身份模型调用与按用途用量查询）。
export {
  KNOWLEDGE_TAG_MODEL_ALIAS,
  mapPlatformCompletionError,
  PLATFORM_MAX_OUTPUT_TOKENS,
  PLATFORM_PURPOSES,
  platformCompletion,
  PlatformCompletionError,
  queryPlatformUsage,
} from "./services/platform-completions.ts";
export type {
  PlatformChatMessage,
  PlatformCompletionErrorCode,
  PlatformCompletionInput,
  PlatformCompletionResult,
  PlatformCompletionUsage,
  PlatformPurpose,
  PlatformUsageSummary,
} from "./services/platform-completions.ts";
