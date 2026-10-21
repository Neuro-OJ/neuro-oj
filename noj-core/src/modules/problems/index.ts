export type { ContestAccessInfo } from "./services/contest-access-info.ts";
export { resolveProblemAccess } from "./services/problem-access.ts";
export type {
  ProblemAccessContext,
  ProblemAccessInput,
  ProblemAccessResult,
  ProblemSecrecyInfo,
} from "./services/problem-access.ts";
export {
  evaluateProblemAccess,
  evaluateProblemAccessWithContestId,
} from "./services/problem-access-check.ts";
export type {
  ProblemAccessEvaluation,
} from "./services/problem-access-check.ts";
export {
  assertProblemEditPermission,
  assertProblemEditPermissionForActor,
  createDomainProblem,
  createDomainProblemForActor,
  createProblem,
  createProblemForActor,
  deleteProblem,
  getDefaultDomainProblemByNumber,
  getProblem,
  listAllProblems,
  listProblems,
  syncProblemTags,
  updateProblem,
  updateProblemForActor,
  validateRuntimeConfig,
} from "./services/problems/problems.ts";
export type {
  AdminProblemListItem,
  AdminProblemListResponse,
  ProblemListResponse,
  ProblemResponse,
} from "./services/problems/problems.ts";
export {
  applyAlgorithmTagVisibility,
  attachTags,
  type ProblemViewer,
} from "./services/problems/problems-list.ts";
export {
  importProblemBundle,
  importProblemBundleForActor,
  publishImportedProblem,
  publishImportedProblemForActor,
  requireProblemById,
  syncProblemDraftFromProjection,
} from "./services/problems/problem-bundle.ts";
export type { BundleImportActor } from "./services/problems/problem-bundle.ts";
export {
  assertSensitiveFieldPermissions,
  enforceResourceLimits,
  RESOURCE_LIMIT_SETTINGS,
  SENSITIVE_FIELD_PERMISSIONS,
} from "./services/problems/problem-field-guard.ts";
export {
  getProblemStatsDetail,
  getPublicProblemStats,
  MAX_STATS_SAMPLE,
  median,
  type ProblemStatsDetail,
  type PublicProblemStats,
  STATS_CACHE_TTL_MS,
} from "./services/problems/problems-stats.ts";
export {
  createTag,
  deleteTag,
  getTag,
  getTagIdsByNames,
  isValidTagKind,
  listTags,
  mergeTags,
  TAG_KINDS,
  updateTag,
} from "./services/tags.ts";
export type {
  CreateTagInput,
  TagKind,
  TagResponse,
  UpdateTagInput,
} from "./services/tags.ts";
export {
  addTrainingProblem,
  createTraining,
  deleteTraining,
  getTraining,
  listAllTrainings,
  listMyTrainings,
  listPublicTrainings,
  listTrainingProblems,
  listTrainingsContainingProblem,
  listUserTrainings,
  removeTrainingProblem,
  reorderTrainingProblems,
  resolveTrainingId,
  updateTraining,
} from "./services/trainings.ts";
export type {
  ListTrainingsParams,
  ListTrainingsResult,
  UpdateTrainingOptions,
} from "./services/trainings.ts";
export {
  deleteSupportPackage,
  deleteSupportPackageForActor,
  deleteSupportPackageForActorTx,
  extractTemplateFromPackage,
  extractUiHtmlFromPackage,
  finalizeDeletedSupportPackage,
  getDraftSupportPackageUrl,
  getProblemTemplate,
  getSupportPackageBytes,
  getVersionSupportPackageUrl,
  MAX_SUPPORT_PACKAGE_SIZE,
  resolveProblemTemplate,
  resolveProblemUiHtml,
  resolveSupportPackageRef,
  setSupportPackage,
} from "./services/support-package.ts";
export type { ResolvedSupportPackage } from "./services/support-package.ts";
export {
  resolveProblem,
  resolveProblemIdOrNull,
  resolveProblemIdOrThrow,
} from "./services/problem-resolve.ts";
export {
  inspectEvaluationPackage,
  MAX_FILE_SIZE,
  MAX_TOTAL_SIZE,
  MAX_ZIP_ENTRIES,
  parseBundleZip,
  readBundleTemplate,
  readBundleUi,
  readEvaluationEntries,
  stripMetadataEntries,
} from "./services/bundle-parser.ts";
export type {
  BundleTemplateReadResult,
  BundleUiReadResult,
  EvaluationPackageInspection,
  ParsedProblemBundle,
} from "./services/bundle-parser.ts";
export {
  DIFFICULTIES,
  getJudgeBackend,
  getSubmissionLanguages,
  isImageInWhitelist,
  isOiRuntimeConfig,
  isValidDifficulty,
  isValidJudgeImageKind,
  isValidLlmConfig,
  isValidSubmissionMode,
  JUDGE_IMAGE_KINDS,
  judgeTypeForRuntimeConfig,
  LLM_DEFAULT_MODEL_ALIAS,
  LLM_MAX_MODELS_PER_PROBLEM,
  LLM_MODEL_ALIAS_PATTERN,
  parseImageRef,
  SUBMISSION_MODES,
  validateOiRuntimeConfig,
} from "./types/problems.ts";
export type {
  CreateJudgeImageInput,
  CreateProblemInput,
  Difficulty,
  EvaluatorRuntime,
  JudgeBackend,
  JudgeImageKind,
  JudgeImageResponse,
  JudgeType,
  LlmConfig,
  OiRuntimeConfig,
  ParsedImageRef,
  ProblemListQuery,
  ProblemResponseWithTags,
  ProblemRuntimeConfig,
  ProblemTagRef,
  RuntimeConfig,
  SolutionRuntime,
  SubmissionMode,
  UpdateJudgeImageInput,
  UpdateProblemInput,
} from "./types/problems.ts";
export {
  BUNDLE_FORMAT_VERSION,
  BUNDLE_METADATA_ENTRIES,
  DEFAULT_EVALUATOR_COMMAND,
  DEFAULT_TEMPLATE_FILE,
  isValidProblemBundleName,
  isValidTemplateFileName,
  MAX_TEMPLATE_BYTES,
  MAX_UI_HTML_BYTES,
  normalizeBundleManifestFormat,
  resolveManifestCommand,
  UI_FILE,
  validateBundleManifest,
  validateObjectiveQuestions,
} from "./types/problem-bundle.ts";
export type {
  ObjectiveQuestionBundleInput,
  ProblemBundleManifest,
} from "./types/problem-bundle.ts";
export {
  isValidTrainingVisibility,
  TRAINING_VISIBILITIES,
} from "./types/trainings.ts";
export type {
  CreateTrainingInput,
  TrainingProblemResponse,
  TrainingResponse,
  TrainingVisibility,
  UpdateTrainingInput,
} from "./types/trainings.ts";
export type { OiSubtask, OiTestCase } from "./types/runtime-config.ts";
export {
  getBuiltinOiCostProfile,
  getOiMeteringStandard,
  isValidOiCostProfile,
  OI_VARIABLE_COST_KEYS,
} from "./types/oi-cost-profile.ts";
export type { OiCostProfile } from "./types/oi-cost-profile.ts";
export {
  buildOiSelfTestPackage,
  validateOiSelfTestCases,
} from "./services/oi-self-test-package.ts";
export type { OiSelfTestCase } from "./services/oi-self-test-package.ts";
export {
  assertContentKindTransition,
  canonicalJson,
  computeProblemContentHash,
  PROBLEM_CONTENT_SCHEMA_VERSION,
  problemContentKindOf,
  validateObjectiveQuestionSnapshots,
  validateProblemContent,
} from "./types/problem-content.ts";
export type {
  AiProblemContent,
  ObjectiveProblemContent,
  ObjectiveQuestionSnapshot,
  OiProblemContent,
  ProblemContentBase,
  ProblemContentFileRef,
  ProblemContentKind,
  ProblemContentV1,
  ProblemDraftContent,
} from "./types/problem-content.ts";
export type { ProblemSample } from "./types/problem-samples.ts";
export {
  deriveDraftContentFromProblem,
  draftBaselineConflict,
  draftRevisionConflict,
  draftRevisionRequired,
  getProblemDraft,
  listDraftObjects,
  loadProblemIdentity,
  PROBLEM_DRAFT_VIRTUAL_REVISION,
  removeDraftObject,
  replaceDraftObjectsForRole,
  saveProblemDraft,
  saveProblemDraftWithObjects,
  setDraftObject,
} from "./services/versioning/draft.ts";
export type {
  DraftObjectRef,
  ProblemDraftView,
  ProblemIdentityRow,
} from "./services/versioning/draft.ts";
export {
  getProblemVersionOrThrow,
  listProblemVersions,
  listVersionObjects,
  preflightProblemDraft,
  publishProblemVersion,
  resolveProblemAnswerVersion,
  SUPPORT_PACKAGE_PATH,
} from "./services/versioning/publish.ts";
export type {
  ProblemVersionContentView,
  ProblemVersionSummary,
  PublishPreflightFile,
  PublishPreflightIssue,
  PublishPreflightReport,
  PublishProblemVersionResult,
} from "./services/versioning/publish.ts";
export {
  buildProblemVersionRead,
  persistedJudgeType,
  trimProblemContentForViewer,
} from "./services/versioning/version-read-view.ts";
export type {
  ProblemVersionReadInput,
  VersionContentOverrides,
} from "./services/versioning/version-read-view.ts";
export {
  isSavedDraft,
  listDraftOiFileRefs,
  listDraftOiFiles,
  listVersionOiFileRefs,
  loadOiDataFromDraft,
  loadOiDataFromVersion,
  MAX_OI_FILE_COUNT,
  MAX_OI_FILE_SIZE,
  MAX_OI_TOTAL_SIZE,
  saveOiDraft,
  validateOiConfigReferences,
} from "./services/versioning/oi-draft.ts";
export type { SaveOiDraftResult } from "./services/versioning/oi-draft.ts";
export {
  domainProblemReference,
  parseDomainProblemReference,
} from "./services/workspace/problem-reference.ts";
export {
  assertCurrentProblemShare,
  legacyWorkspaceFromAccess,
  resolveDomainProblem,
  resolveDomainProblemInWorkspace,
} from "./services/workspace/problem-binding-access.ts";
export {
  importDomainProblem,
  importDomainProblemForActor,
  listDomainProblemBindings,
  setDomainProblemBindingPolicy,
  setDomainProblemBindingPolicyForActorTx,
  setDomainProblemBindingState,
  setDomainProblemBindingStateForActor,
} from "./services/workspace/problem-bindings.ts";
export {
  listDomainTrainings,
  lockTrainingExpansion,
  readDomainTraining,
  resolveDomainTraining,
} from "./services/workspace/training-access.ts";
export {
  importDomainTraining,
  readDomainTrainingSharing,
  setDomainTrainingSharing,
} from "./services/workspace/training-sharing.ts";
export { saveDomainTraining } from "./services/workspace/trainings.ts";
export type { DomainTrainingInput } from "./services/workspace/trainings.ts";
export {
  listSharedDomainResources,
  readDomainProblemSharing,
  resolveSharingTargetSlugs,
  setDomainProblemSharing,
} from "./services/workspace/problem-sharing.ts";
export {
  listDomainProblems,
  listDomainProblemVersions,
  readDomainProblem,
  readDomainProblemTemplate,
} from "./services/workspace/problem-read.ts";
export {
  listEditableDomainProblemDrafts,
} from "./services/workspace/problem-draft-list.ts";
export {
  loadEditableDomainProblem,
  preflightDomainProblemVersion,
  publishDomainProblemVersion,
  readDomainProblemDraft,
  saveDomainProblemDraft,
} from "./services/workspace/problem-edit.ts";
export {
  importDomainProblemBundle,
} from "./services/workspace/problem-bundle-import.ts";
export { backfillDefaultCatalog } from "./services/workspace/backfill.ts";
export {
  assertDefaultProblemSource,
  resolveDefaultExecutionContext,
  resolveDefaultExecutionContexts,
} from "./services/workspace/execution-context.ts";
export {
  domainProblemAvailableWhere,
  domainProblemBindingAvailableWhere,
  loadBindingAvailability,
} from "./services/workspace/binding-availability.ts";
export type {
  BindingAvailability,
} from "./services/workspace/binding-availability.ts";
export {
  recordProblemEducationChange,
  recordPublishedBindingChanges,
  recordSourceDomainEducationChange,
} from "./services/workspace/education-events.ts";

export { domainResourceManagementRouter } from "./routes/domain-resource-management.ts";
export {
  getProblemVersionSnapshot,
  projectProblemContent,
  serializeQuestion as serializeProblemQuestion,
} from "./contracts/read.ts";
export type {
  ProblemAccessDecision,
  ProblemShareSnapshot,
  ProblemVersionSnapshot,
} from "./contracts/read.ts";

// 客观题内容属于 problems；判分、提交与重判仍由 evaluations 侧持有。
export {
  assertObjectivePaper,
  assertPaperManageable,
  assertPaperManageableForActor,
  getPaperOrThrow,
  isPaperOwnerOrAdmin,
  isPaperOwnerOrAdminForActor,
  judgeOptions,
  listPaperQuestions,
  listPaperQuestionsWithAccess,
  type PaperRow,
  resolvePaperId,
  resolvePaperIdToUuid,
  serializeQuestion,
} from "./services/objective/objective-questions.ts";
export {
  createDraftQuestion,
  deleteDraftQuestion,
  listDraftQuestions,
  replaceDraftQuestions,
  updateDraftQuestion,
} from "./services/objective/versioning/objective-drafts.ts";
export {
  listVersionQuestions,
  resolveQuestionsForJudging,
} from "./contracts/objective.ts";
export {
  isValidQuestionType,
  JUDGE_OPTIONS,
  QUESTION_TYPES,
  validateAnswerForType,
  validateAnswersPayload,
  validateOptions,
} from "./types/objective.ts";
export type {
  CreateQuestionInput,
  ObjectiveAnswerValue,
  ObjectiveAttemptSummary,
  ObjectiveAttemptView,
  ObjectiveOption,
  ObjectiveQuestionResponse,
  ObjectiveSubmissionList,
  ObjectiveSubmissionResponse,
  QuestionJudgement,
  QuestionType,
  SubmitObjectiveContestReceipt,
  SubmitObjectiveInput,
  SubmitObjectiveResponse,
  SubmitObjectiveResult,
  UpdateQuestionInput,
} from "./types/objective.ts";
