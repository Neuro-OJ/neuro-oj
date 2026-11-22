/**
 * 客观题内容只读合同。
 *
 * evaluations 只能通过这个合同读取不可变版本中的题目快照；套卷草稿写入和
 * 小题管理由 problems application 用例负责。这里不暴露提交、判分或重判入口，
 * 也不把 objective service 深路径泄漏给跨模块调用方。
 */
export {
  listVersionQuestions,
  resolveQuestionsForJudging,
} from "../services/objective/versioning/objective-drafts.ts";
export type { ObjectiveQuestionSnapshot } from "../types/problem-content.ts";
