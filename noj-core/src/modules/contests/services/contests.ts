// 竞赛门面：汇总竞赛读写、参与者管理与输入校验等子模块的对外导出（原导出集合保持不变）。
export type { ListContestsParams, ListContestsResult } from "./contest-read.ts";
export type { ContestParticipantResponse } from "./contest-participants.ts";

export {
  createContest,
  deleteContest,
  resolveContestId,
  updateContest,
} from "./contest-write.ts";
export { getContest, listContests } from "./contest-read.ts";
export {
  addParticipants,
  assertContestSubmissionLimit,
  isParticipant,
  listParticipants,
  registerForContest,
  removeParticipant,
} from "./contest-participants.ts";
export { computeContestStatus } from "./contest-window.ts";
export { getContestProblems } from "./contest-problems.ts";
