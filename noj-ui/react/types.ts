import type { ProblemResource } from '../utils/problemView.ts';
import type { SubmissionListItem } from '../utils/submissionFormat.ts';

export interface User {
  id: string;
  username: string;
  email: string;
  avatar_url?: string | null;
  is_admin: boolean;
  must_change_password: boolean;
  email_verified?: boolean;
  legal?: import('../utils/legalConsent.ts').LegalStatusMap;
}

export interface Problem extends ProblemResource {
  supported_languages?: string[];
}

export interface ProblemList {
  data: Problem[];
  total: number;
  page: number;
  limit: number;
}

export interface Submission extends Omit<SubmissionListItem, 'problem'> {
  problem?: SubmissionListItem['problem'];
  code?: string | null;
  queue_position?: number;
  is_latest?: boolean;
  effective_version_policy?: { mode: 'any' | 'exact'; version_id?: string | null };
  version_results?: VersionResult[];
  attempts?: Attempt[];
  result:
    | (NonNullable<SubmissionListItem['result']> & {
      output?: string | null;
      output_truncated?: boolean;
      details?: Record<string, unknown> | null;
    })
    | null;
}

export interface VersionResult {
  attempt_id: string;
  version: number | null;
  status: string;
  score: number;
  is_effective: boolean;
  is_accepted: boolean;
}

export interface Attempt extends VersionResult {
  sequence: number;
  source: string;
  state: string;
  result_kind: string | null;
  created_at: string;
}

export interface SubmissionList {
  data: Submission[];
  pagination: { total: number; total_pages: number };
}

export interface ResourceError {
  message: string;
  status: number;
  code?: string;
  requestId?: string;
}

export interface ResourceSnapshot {
  data?: unknown;
  error?: ResourceError;
}

/** 每次 SSR 请求单独创建，不在服务器进程中共享用户或接口缓存。 */
export interface Bootstrap {
  url: string;
  user: User | null;
  authError?: ResourceError;
  status?: number;
  resources: Record<string, ResourceSnapshot>;
}

export interface SelfTest {
  id: string;
  status: string;
  output?: string | null;
  error_message?: string | null;
  details?: Record<string, unknown> | null;
}

export interface Question {
  id: string;
  type: 'single' | 'multiple' | 'judge';
  prompt: string;
  options: { key: string; text: string }[];
}

export interface ObjectiveResult {
  score: number | null;
  correct_count: number | null;
  total_count: number;
  details: Record<string, { correct?: boolean; explanation?: string; given: (string | boolean)[] }>;
}
