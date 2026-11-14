/**
 * 知识图谱功能对外出口（见 README.md）。
 *
 * 其他功能与旧模块只能从这里引用知识图谱能力；本目录内部文件互相直接引用。
 * 表定义在 `src/shared/db/schema/knowledge.ts`，API 在 `routes.ts`，题目挂载与
 * 审核逻辑在 `mappings.ts`。
 */
import { defineFeature } from "../../shared/feature.ts";
import { knowledgeRouter } from "./routes.ts";
import { startDifficultyRecalibrateWorker } from "./difficulty.ts";
import { KNOWLEDGE_TAG_TASK_TYPE, knowledgeTagHandler } from "./tagging.ts";

export const feature = defineFeature({
  name: "knowledge",
  router: knowledgeRouter,
  // AI 打标任务（P1，默认关闭）：由题目发布事务投递，target = 题目。
  tasks: { [KNOWLEDGE_TAG_TASK_TYPE]: knowledgeTagHandler },
  // 难度每日重算（P2）：24h 一次，启动后不立即执行，多副本经 advisory lock 互斥。
  workers: [startDifficultyRecalibrateWorker],
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
  calibrateDifficulty,
  DIFFICULTY_RECALIBRATE_INTERVAL_MS,
  DIFFICULTY_RECALIBRATE_LOCK,
  type DifficultyTier,
  isPassingScore,
  type LadderItem,
  loadNodeProblemCounts,
  loadPassedProblems,
  loadProblemStats,
  type NodeLadderView,
  passRatio,
  passScoreOf,
  pickNextLadderItem,
  PRIOR_STRENGTH,
  type ProblemDifficultyView,
  readNextForProblem,
  readNodeLadder,
  readProblemDifficulty,
  recalibrateAll,
  recalibrateProblem,
  resolveAccessibleDomain,
  resolvePassScore,
  runExclusiveRecalibration,
  startDifficultyRecalibrateWorker,
  tierOf,
  tierToPrior,
} from "./difficulty.ts";
export { objectiveFullScore } from "./objective-full-score.ts";
export { setPassRatioOverride } from "./pass-ratio.ts";
export {
  type KnowledgePack,
  loadPackFromDir,
  normalizePackRelativePath,
  type PackArea,
  type PackNode,
  readDocMarkdown,
  resolveDocsDir,
  resolveOfficialPackDir,
  validatePack,
} from "./pack.ts";
