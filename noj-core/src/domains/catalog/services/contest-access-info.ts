/**
 * 竞赛访问信息（轻量类型）。
 *
 * 放在 catalog 域内以避免 catalog → contest 的反向依赖（域边界约束）：
 * contest 域在调用 `resolveProblemAccess` 前先构造该结构，
 * catalog 域的 resolver 只消费这一"判定结果"，不感知 contest 域实现。
 *
 * 提交/读取路径的通用约定：
 * - `allowed=false` 时 resolver 一律拒绝，且不回退 public 判定（防伪造上下文）。
 */

/** 竞赛上下文访问判定结果（由 contest 域 verifyContestAccess 产出）。 */
export type ContestAccessInfo = {
  /** 竞赛 UUID */
  contestId: string;
  /** 成员 + 窗口（running 或 ended）校验是否通过；赛前一律 false */
  allowed: boolean;
  /** 当前是否处于竞赛窗口内（running）；ended 时为 false */
  running: boolean;
};
