/**
 * 代码自测（self-test）类型定义（issue #221）。
 *
 * 自测与正式提交共用评测流程，但结果只写入独立的 `self_tests` 表，
 * 不参与正式统计/榜单/AC 活动。
 */

/** 自测 ID 前缀：用于 core 消费者区分自测结果与正式提交结果。 */
export const SELF_TEST_ID_PREFIX = "st_";

/** 自测状态枚举。 */
export const SELF_TEST_STATUSES = [
  "pending",
  "judging",
  "finished",
  "error",
] as const;

export type SelfTestStatus = typeof SELF_TEST_STATUSES[number];

/** 创建自测的请求体（problem_id 从 URL 获取，不放在 body）。 */
export interface SelfTestInput {
  language: string;
  code: string;
  file_name?: string;
}

/** 创建自测成功后的响应（基础字段，不含 result）。 */
export interface SelfTestResponse {
  id: string;
  user_id: string;
  problem_id: string;
  language: string;
  code: string;
  file_name: string | null;
  status: SelfTestStatus;
  created_at: string;
}

/**
 * 自测详情响应。
 * 仅 owner/admin 可见，output 按 API 层截断返回。
 */
export interface SelfTestDetail {
  id: string;
  user_id: string;
  problem_id: string;
  language: string;
  code: string | null;
  file_name: string | null;
  status: SelfTestStatus;
  /** 评测结果状态（新协议下为 finished / error），未完成时为 null。 */
  result_status: string | null;
  score: number;
  output: string | null;
  output_truncated: boolean | null;
  details: Record<string, unknown> | null;
  time_ms: number | null;
  memory_kb: number | null;
  judge_started_at: string | null;
  judge_finished_at: string | null;
  created_at: string;
}
