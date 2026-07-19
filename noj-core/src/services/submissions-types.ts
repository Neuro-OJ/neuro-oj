/**
 * Submissions 模块共享类型（PR-3 拆分）。
 *
 * 集中管理 SubmissionInput / SubmissionResponse / SubmissionDetail /
 * SubmissionListItem 等公开 DTO，避免拆分后多文件互相 import 形成循环依赖。
 */
import type { SubmissionStatus } from "../types/index.ts";

/** 创建提交的请求体 */
export interface SubmissionInput {
  problem_id: string;
  language: string;
  code: string;
  file_name?: string;
}

/** 创建提交成功后的响应（基础字段，不含 result） */
export interface SubmissionResponse {
  id: string;
  user_id: string;
  problem_id: string;
  language: string;
  code: string;
  file_name: string | null;
  status: SubmissionStatus;
  created_at: string;
}

/**
 * 提交详情响应——基础数据公开，详细内容（code/output/details）按权限裁剪。
 *
 * - viewer 是 owner 或 admin → `code`/`output`/`details` 完整返回（output 可能被截断）
 * - viewer 是匿名用户或登录非 owner → `code`/`output`/`details` 均为 null
 */
export interface SubmissionDetail {
  id: string;
  user_id: string;
  problem_id: string;
  language: string;
  /** 源代码：仅 owner/admin 可见，否则为 null */
  code: string | null;
  file_name: string | null;
  status: SubmissionStatus;
  created_at: string;
  result: {
    status: string;
    score: number;
    /** 评测脚本输出：仅 owner/admin 可见（可能被截断至 8KB），否则为 null */
    output: string | null;
    /** output 是否被 API 层截断（issue 64 评论 §5.1）；非 owner/admin 为 null */
    output_truncated: boolean | null;
    time_ms: number | null;
    memory_kb: number | null;
    /** 评测用例级详情：仅 owner/admin 可见，否则为 null */
    details: Record<string, unknown> | null;
  } | null;
  /** 排队位置（1-based），仅在 pending/等待中时有值。 */
  queue_position?: number | null;
  /** 当前 pending 队列总长度。 */
  queue_length?: number | null;
  /** 开始评测时间。 */
  judge_started_at?: string | null;
  /** 评测完成时间。 */
  judge_finished_at?: string | null;
}

/**
 * 提交列表项——不含 code 字段，附带题目和评测摘要。
 */
export interface SubmissionListItem {
  id: string;
  user_id: string;
  problem_id: string;
  language: string;
  file_name: string | null;
  status: SubmissionStatus;
  created_at: string;
  judge_started_at: string | null;
  judge_finished_at: string | null;
  queue_position: number | null;
  queue_length: number | null;
  problem: {
    id: string;
    title: string;
    time_limit_ms: number | null;
    memory_limit_mb: number | null;
  };
  result: {
    status: string;
    score: number;
    time_ms: number | null;
    memory_kb: number | null;
  } | null;
}

/** 列表查询参数 */
export interface ListSubmissionsParams {
  userId?: string;
  problemId?: string;
  problemSearch?: string;
  submissionId?: string;
  userSearch?: string;
  language?: string;
  status?: string;
  from?: string;
  to?: string;
  page: number;
  perPage: number;
}

/** 列表查询结果 */
export interface ListSubmissionsResult {
  data: SubmissionListItem[];
  total: number;
}

/** 今日提交统计（PR-3 拆分至 submissions-stats.ts） */
export interface TodayStats {
  total: number;
  full_score: number;
  not_full_score: number;
}
