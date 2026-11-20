/**
 * 客观题提交表的兼容入口。
 *
 * 客观题提交与普通提交、评测尝试共享循环外键，定义已集中到
 * `evaluation-records.ts`；本文件只做显式转出，避免
 * `objective.ts` / `submission.ts` 再次互相导入形成运行时环。
 */
export { objectiveSubmissions } from "./evaluation-records.ts";
