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
import {
  knowledgeMasteryHandler,
  MASTERY_TASK_TYPE,
  startMasteryProtectionWorker,
} from "./mastery.ts";

export const feature = defineFeature({
  name: "knowledge",
  router: knowledgeRouter,
  // AI 打标任务（P1，默认关闭）：由题目发布事务投递，target = 题目。
  tasks: {
    [KNOWLEDGE_TAG_TASK_TYPE]: knowledgeTagHandler,
    // 掌握度增量重算（P3）：有效成绩变更时投递，target = 用户。
    [MASTERY_TASK_TYPE]: knowledgeMasteryHandler,
  },
  // 难度每日重算（P2）：24h 一次，启动后不立即执行，多副本经 advisory lock 互斥。
  workers: [startDifficultyRecalibrateWorker, startMasteryProtectionWorker],
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
  adaptiveStep,
  applyForgettingDecay,
  ATTEMPT_EVIDENCE_FACTOR,
  computeNodeAbility,
  computeScoreRatio,
  DECAY_FLOOR_RATIO,
  DECAY_GRACE_DAYS,
  DECAY_HALF_LIFE_DAYS,
  type DecayedAbilityView,
  deduplicateObservations,
  ELO_ALPHA,
  ELO_K0,
  ELO_SCALE,
  expectedScore,
  INITIAL_ABILITY,
  type KnowledgeMappingRole,
  MASTERED_MIN_ABILITY,
  type NodeAbilitySummary,
  type ProblemAbilityObservation,
  REVIEW_TRIGGER_DAYS,
  ROLE_WEIGHT_PRIMARY,
  ROLE_WEIGHT_SECONDARY,
  roleWeightOf,
  SPARSE_HARD_DIFFICULTY,
  SPARSE_HARD_MIN_ABILITY,
  SPARSE_MASTERED_MIN_EVIDENCE,
} from "./ability.ts";
export {
  type CoverageNodeItem,
  type CoverageView,
  readCoverage,
} from "./coverage.ts";
export {
  computeNodeMastery,
  diagnoseNode,
  DIAGNOSIS_MAX_ITEMS,
  type DiagnosisItem,
  knowledgeMasteryHandler,
  loadUserMastery,
  loadUserPlacementIds,
  loadUserProblemScores,
  MASTERY_PROTECTION_INTERVAL_MS,
  type MasteryItem,
  masteryMinSolved,
  type MasteryState,
  type MyMasteryView,
  type MyRecommendationsView,
  type NodeDiagnosisView,
  type NodeMasteryInput,
  type NodeMasteryResult,
  rankFrontierNodes,
  readMyMastery,
  readMyRecommendations,
  type Recommendation,
  RECOMMENDATION_TARGET_OFFSET,
  type RecommendationReason,
  RECOMMENDATIONS_MAX_LIMIT,
  recomputeRecentlyUnprotectedMastery,
  recomputeUserMastery,
  ROOT_CAUSE_THRESHOLD,
  startMasteryProtectionWorker,
  upperThirdThreshold,
  type UserMasteryRecord,
  type UserMasteryResult,
} from "./mastery.ts";
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
  computeDownstreamReach,
  DIAGNOSTIC_MAX_CHECKPOINTS,
  type DiagnosticAreaSummary,
  type DiagnosticCheckpoint,
  type DiagnosticPlanView,
  readDiagnosticPlan,
  saveSelfAssessedPlacements,
  selectDiagnosticCheckpoints,
  type SelfAssessInput,
  type SelfAssessResult,
} from "./diagnostic.ts";
export {
  matchSignalsToNodes,
  parseFeedbackSignalParam,
  type ProblemRemediationView,
  readProblemRemediation,
  type RemediationNodeItem,
  type RemediationReason,
} from "./remediation.ts";
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
  validatePackDocs,
} from "./pack.ts";
