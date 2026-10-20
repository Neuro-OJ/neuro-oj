/**
 * evaluations 稳定公共门面。
 *
 * 只导出提交/结果/读模型合同和业务能力；consumer、sweeper、job worker、测试
 * reset 与内部 dispatch 实现必须从 runtime 私有装配点导入，不能通过本门面泄漏。
 */
export {
  createSubmission,
  deleteSubmission,
  getSubmission,
  listSubmissions,
  rejudgeProblemSubmissions,
  rejudgeSubmission,
  resolveSubmissionId,
  saveEvaluationResult,
  saveEvaluationResultTx,
  updateSubmissionStatus,
} from "./services/submissions/submissions.ts";
export type {
  ListSubmissionsParams,
  ListSubmissionsResult,
  SubmissionDetail,
  SubmissionInput,
  SubmissionListItem,
  SubmissionResponse,
  TodayStats,
} from "./services/submissions/submissions.ts";

export {
  createArtifactSubmission,
  createUploadedSubmission,
  DEFAULT_ARTIFACT_MAX_SIZE_BYTES,
  getArtifactHardLimit,
} from "./services/submissions/artifact-submissions.ts";
export type {
  UploadedSubmissionInput,
  UploadedSubmissionSpec,
} from "./services/submissions/artifact-submissions.ts";
export { createPredictionSubmission } from "./services/submissions/prediction-submissions.ts";
export type { PredictionSubmissionInput } from "./services/submissions/prediction-submissions.ts";

export {
  createDomainArtifactSubmission,
  createDomainSelfTest,
  createDomainSubmission,
} from "./services/domain-submissions.ts";
export {
  getDomainSubmission,
  listDomainSubmissions,
} from "./services/domain-submission-read.ts";
export type { DomainSubmissionDetail } from "./services/domain-submission-read.ts";
export {
  getDomainObjectiveSubmissionHistory,
  getOwnSubmissionHistory,
  listOwnSubmissionHistory,
} from "./services/own-submission-history.ts";
export type {
  OwnSubmissionHistoryItem,
  OwnSubmissionHistoryScope,
  OwnSubmissionKind,
} from "./services/own-submission-history.ts";
export { backfillExecutionWorkspaces } from "./services/workspace-backfill.ts";
export {
  cancelDomainSelfTest,
  getDomainSelfTest,
  listDomainSelfTests,
} from "./services/domain-self-test-read.ts";
export {
  cancelSelfTest,
  createSelfTest,
  getSelfTest,
  listMySelfTests,
  saveSelfTestResult,
} from "./services/self-tests.ts";
export type { DomainExecutionRequest } from "./services/workspace-execution.ts";
export {
  lockDomainExecution,
  resolveDomainExecution,
} from "./services/workspace-execution.ts";

export {
  getPendingQueueLength,
  getPendingQueuePosition,
  getPendingQueueSnapshot,
  getPendingSubmissionIds,
  getQueueHealth,
  getQueueOverview,
  getSubmissionQueueStatus,
  matchingResourceWaitReason,
  queueEventChannel,
  removePendingSubmission,
} from "./services/queue.ts";
export type {
  QueueHealthResponse,
  SubmissionStatusResponse,
} from "./services/queue.ts";
export { JUDGE_QUEUES } from "./mq/producer.ts";

export {
  applySubmissionProjection,
  contestResultVisibility,
} from "./services/submissions/submission-projection.ts";
export type { ProjectionCtx } from "./services/submissions/submission-projection.ts";
export {
  OI_VERDICTS,
  oiVerdict,
  projectMeteringDetails,
  projectOiDetails,
  projectOiSelfTestDetails,
} from "./services/submissions/oi-details.ts";
export type { OiVerdict } from "./services/submissions/oi-details.ts";

export {
  assertVersionAcceptsSubmission,
  contestVersionChanged,
  loadPublishedVersionContent,
  resolveSubmissionVersion,
  versionNotFound,
  versionRequired,
} from "./services/versioning/submission-version.ts";
export type {
  ResolvedSubmissionVersion,
  SubmissionVersionResolution,
} from "./services/versioning/submission-version.ts";
export {
  assertExecutionPreflight,
  assertVersionAcceptance,
  scriptTemplateOf,
  versionSupportPackageDownload,
  versionSupportPackageUrl,
} from "./services/versioning/version-execution.ts";
export type {
  ExecutionPreflightInput,
  VersionAcceptanceInput,
} from "./services/versioning/version-execution.ts";

export {
  applyAttemptResult,
  listAttempts,
} from "./services/versioning/result-write.ts";
export type {
  ApplyAttemptOutcome,
  ApplyAttemptResultInput,
} from "./services/versioning/result-write.ts";
export {
  createAttempt,
  finishAttempt,
  getAttempt,
  isTerminalAttemptState,
  markAttemptStarted,
  nextAttemptSequence,
  registerAttemptTerminalRevocation,
  runAttemptTerminalRevocationAfterCommit,
  supersedeAttempt,
} from "./services/versioning/attempts.ts";
export type {
  AttemptRecord,
  CreateAttemptInput,
  FinishAttemptInput,
} from "./services/versioning/attempts.ts";
export {
  bumpProjectionRevision,
  bumpSubmissionCountRevisions,
  computeSubmissionProjection,
  contestScopeKey,
  deleteVersionResultsForSource,
  globalScopeKey,
  lockProjectionHosts,
  lockProjectionSource,
  problemScopeKey,
  recomputeContestProblemProjections,
  recomputeProblemBindingProjections,
  recomputeProblemProjections,
  recomputeSubmissionProjection,
  upsertCurrentVersionResult,
} from "./services/versioning/projection.ts";
export type {
  ProjectionSource,
  ProjectionSourceKind,
  SubmissionProjectionPlan,
} from "./services/versioning/projection.ts";

export {
  acceptRejudgeJob,
  countItemsByStatus,
  getRejudgeJob,
  hashCanonical,
  hashRequest,
  hashRetryRequest,
  idempotencyConflict,
  listRejudgeJobItems,
  missingTargetVersion,
  normalizeRejudgeRequest,
  refreshJobStatus,
  retryRejudgeJob,
} from "./services/versioning/rejudge-jobs.ts";
export type {
  AcceptJobResult,
  JobItemView,
  JobView,
  PolicyChangeRequest,
  RejudgeRequest,
  RejudgeScope,
  RejudgeTarget,
} from "./services/versioning/rejudge-jobs.ts";
export {
  acceptDomainSubmissionJob,
  cancelDomainSubmissionJob,
  getDomainSubmissionJob,
  listDomainSubmissionJobItems,
} from "./services/versioning/domain-jobs.ts";
export type { DomainJobRequest } from "./services/versioning/domain-jobs.ts";
export {
  setContestProblemEffectiveVersionPolicy,
  setProblemEffectiveVersionPolicy,
  upgradeContestProblemPinnedVersion,
} from "./services/versioning/effective-policy.ts";
export type {
  PolicyChangeResult,
  PolicyHostLockStrength,
} from "./services/versioning/effective-policy.ts";
export {
  acceptUpgradeJob,
  getUpgradeJobForActor,
} from "./services/versioning/upgrade-jobs.ts";
export type {
  AcceptUpgradeResult,
  UpgradeContext,
  UpgradeRequest,
} from "./services/versioning/upgrade-jobs.ts";

// 客观题判分、提交和重判属于 evaluations；题面/题库草稿仍由 problems 提供。
export {
  getObjectiveSubmission,
  listObjectiveSubmissions,
  submitObjectivePaper,
} from "./services/objective/objective-submissions.ts";
export {
  judgePaper,
  judgeQuestion,
} from "./services/objective/objective-judge.ts";
export type {
  JudgePaperInput,
  JudgePaperOutput,
  QuestionToJudge,
} from "./services/objective/objective-judge.ts";
export { submitDomainObjectivePaper } from "./services/objective/domain-objective.ts";
export {
  regradeAgainstSnapshot,
} from "./services/objective/versioning/objective-regrade.ts";
export type {
  RegradeDetail,
  RegradeMatch,
  RegradeOutput,
} from "./services/objective/versioning/objective-regrade.ts";
export type {
  ObjectiveRegradeJobInput,
  ObjectiveRegradeJobResult,
} from "./services/objective/versioning/objective-regrade-job.ts";

export type {
  BuildJudgeTaskInput,
  JudgeResourcePool,
  JudgeResult,
  JudgeSubmissionMode,
  JudgeTask,
  JudgeTaskLlm,
  SubmissionStatus,
} from "./types/index.ts";
export {
  assertSubmissionLanguage,
  buildJudgeTask,
  buildUiSolutionScript,
  EVALUATION_PROTOCOL_VERSION,
  isTerminalSubmissionStatus,
  JUDGE_TASK_FIELDS,
  judgeResourcePool,
  LANGUAGE_EXT_MAP,
  parseUiValues,
  SCORE_SCALE,
  scoreFromDb,
  scoreToDb,
  SUBMISSION_STATUSES,
  submissionModeForLanguage,
  toJudgeSubmissionMode,
} from "./types/index.ts";
export type {
  SelfTestDetail,
  SelfTestInput,
  SelfTestResponse,
  SelfTestStatus,
  SelfTestSummary,
} from "./types/self-tests.ts";
export {
  SELF_TEST_ID_PREFIX,
  SELF_TEST_LIST_DEFAULT_LIMIT,
  SELF_TEST_LIST_MAX_LIMIT,
  SELF_TEST_STATUSES,
} from "./types/self-tests.ts";

export type {
  EvaluationAdmissionContext,
  EvaluationReference,
  EvaluationResultEvent,
  EvaluationSource,
} from "./contracts/read.ts";
export { assertEvaluationAdmission } from "./contracts/read.ts";
export {
  hasEvaluationReferences,
  listEvaluationReferences,
} from "./services/reference.ts";
export type { EvaluationWriteActor } from "./services/versioning/tx-contracts.ts";
export {
  applyAttemptResultTx,
  bumpEvaluationRevisionTx,
  bumpSubmissionCountRevisionsTx,
  computeSubmissionProjectionTx,
  createEvaluationAttemptTx,
  deleteVersionResultsForSourceTx,
  finishEvaluationAttemptTx,
  getEvaluationAttemptTx,
  lockEvaluationHostsTx,
  lockProjectionSourceTx,
  markEvaluationAttemptStartedTx,
  recomputeContestProblemProjectionsTx,
  recomputeProblemBindingProjectionsTx,
  recomputeProblemProjectionsTx,
  recomputeSubmissionProjectionTx,
  registerAttemptTerminalRevocationTx,
  supersedeEvaluationAttemptTx,
  upsertCurrentVersionResultTx,
} from "./services/versioning/tx-contracts.ts";
