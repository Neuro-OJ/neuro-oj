/**
 * 兼容旧题目访问调用方的类型路径。
 *
 * 竞赛准入事实的权威合同归 access/contest-policy.ts；problems 只消费这个
 * 不可变 DTO，不依赖 contests service 门面。
 */
export type { ContestAccessInfo } from "../../access/contest-policy.ts";
