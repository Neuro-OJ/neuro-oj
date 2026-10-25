export {
  addParticipants,
  assertContestSubmissionLimit,
  computeContestStatus,
  createContest,
  deleteContest,
  getContest,
  getContestProblems,
  isParticipant,
  listContests,
  listParticipants,
  registerForContest,
  removeParticipant,
  resolveContestId,
  updateContest,
} from "./services/contests.ts";
export { verifyContestAccess } from "./services/contest-access.ts";
export { assertDomainPracticeAllowed } from "./services/practice-admission.ts";
export {
  filterProblemsInRunningContest,
  isProblemInRunningContest,
} from "./services/problem-exposure.ts";
export { getContestPolicySnapshot } from "./contracts/read.ts";
export type {
  ContestAccessInfo,
  ContestPolicySnapshot,
  ContestSecrecyPolicy,
} from "./contracts/read.ts";
export {
  filterUnendedContestIds,
  hasUnendedPublicContest,
  isProblemInUnendedPublicContest,
  loadPublicContestSecrecy,
  type PublicContestSecrecyRef,
  unendedPublicContestForProblem,
} from "./services/problem-secrecy.ts";
export {
  CONTEST_TIME_ISO_REGEX_SQL,
  endedWindowCondition,
  normalizeContestTime,
  normalizeOptionalContestTime,
  runningContestExistsForProblem,
  // 审计规范名（别名）与历史名并存，同一实现
  runningContestForProblem,
  runningContestProblemIds,
  runningWindowCondition,
} from "./services/contest-window.ts";
export {
  createClarification,
  listClarifications,
  replyToClarification,
} from "./services/contest-clarifications.ts";
export {
  getContestFreezeWindow,
  getContestRankingView,
  getContestSettlementStatus,
  getLatestContestRankingSnapshot,
  isContestFrozen,
  listContestRankingSnapshots,
  publishContestRankingSnapshot,
} from "./services/contest-ranking.ts";
export {
  CONTEST_KINDS,
  CONTEST_STATUSES,
  CONTEST_TYPES,
  isValidContestConfig,
  isValidContestKind,
  isValidContestType,
  isValidRankingVisibility,
  RANKING_VISIBILITIES,
} from "./types/contests.ts";
export type {
  ContestConfig,
  ContestKind,
  ContestProblemInput,
  ContestProblemResponse,
  ContestProblemUserStatus,
  ContestResponse,
  ContestStatus,
  ContestType,
  CreateContestInput,
  KaggleContestConfig,
  KaggleProblemScore,
  KaggleRankingRow,
  RankingVisibility,
  UpdateContestInput,
} from "./types/contests.ts";
export { assertContestExists } from "./services/contest-anti-cheat.ts";
export {
  DEFAULT_SIMILARITY_THRESHOLD,
  detectSimilarPairs,
  findSimilarSubmissions,
  fingerprint,
  MAX_SIMILAR_PAIR_LIMIT,
  normalizeCode,
  similarity,
} from "./services/contest-similarity.ts";
export type {
  ContestSimilarSubmissionsResult,
  DetectSimilarPairsOptions,
  FindSimilarSubmissionsOptions,
  FingerprintSet,
  SimilarityCandidate,
  SimilarSubmissionPair,
} from "./services/contest-similarity.ts";
export {
  addDomainContestParticipants,
  createDomainContest,
  getDomainContest,
  listDomainContestParticipants,
  listDomainContests,
  registerForDomainContest,
  removeDomainContestParticipant,
  updateDomainContest,
} from "./services/domain-contests.ts";
export { loadDomainContest } from "./services/domain-access.ts";
export {
  getDomainContestFinalRanking,
  getDomainContestProblems,
  getDomainContestRanking,
  getDomainContestSettlement,
  getDomainContestSnapshots,
  publishDomainContestRanking,
} from "./services/domain-results.ts";
export {
  getDomainContestObjectiveQuestions,
  getDomainContestSubmissionTarget,
  getDomainContestTemplate,
  getDomainContestUi,
} from "./services/domain-content.ts";
export { resolveDefaultContestAccess } from "./services/default-access.ts";
export { loadContestTeachingBasis } from "./services/teaching-basis.ts";
