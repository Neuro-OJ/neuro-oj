/**
 * 知识图谱功能对外出口（见 README.md）。
 *
 * 其他功能与旧模块只能从这里引用知识图谱能力；本目录内部文件互相直接引用。
 * 表定义在 `src/shared/db/schema/knowledge.ts`，API 在 `routes.ts`，题目挂载与
 * 审核逻辑在 `mappings.ts`。
 */
import { defineFeature } from "../../shared/feature.ts";
import { knowledgeRouter } from "./routes.ts";
import { KNOWLEDGE_TAG_TASK_TYPE, knowledgeTagHandler } from "./tagging.ts";

export const feature = defineFeature({
  name: "knowledge",
  router: knowledgeRouter,
  // AI 打标任务（P1，默认关闭）：由题目发布事务投递，target = 题目。
  tasks: { [KNOWLEDGE_TAG_TASK_TYPE]: knowledgeTagHandler },
});

export {
  importPack,
  type ImportPackResult,
  KnowledgePackInvalidError,
} from "./import.ts";
export {
  invalidateKnowledgeGraphCache,
  KNOWLEDGE_GRAPH_CACHE_TTL_MS,
  type KnowledgeGraphView,
  type KnowledgeNodeView,
  readKnowledgeGraph,
  readKnowledgeNode,
} from "./graph.ts";
export {
  type AiMappingResult,
  applyAiMapping,
  type ApplyAiMappingOutcome,
  listPendingMappings,
  loadCurrentMappingState,
  type MappingDecision,
  MAX_SECONDARY_NODES,
  type PendingMappingItem,
  type ProblemKnowledgeView,
  readProblemKnowledge,
  reviewMapping,
  setProblemKnowledgeManually,
} from "./mappings.ts";
export {
  autoAcceptThreshold,
  backfillKnowledgeTags,
  buildTagSystemPrompt,
  buildTagUserPrompt,
  computeTagContentHash,
  ESTIMATE_TOKENS_PER_CHAR,
  estimateBackfill,
  isTaggingEnabled,
  KNOWLEDGE_TAG_TASK_TYPE,
  knowledgeTagHandler,
  readMonthlyUsage,
  readTagUsage,
  TAG_MAX_OUTPUT_TOKENS,
  TAG_PROMPT_VERSION,
  type TagEstimate,
  type TagUsageView,
} from "./tagging.ts";
export {
  type KnowledgePack,
  loadPackFromDir,
  type PackArea,
  type PackNode,
  resolveOfficialPackDir,
  validatePack,
} from "./pack.ts";
