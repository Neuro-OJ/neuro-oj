/** 教学身份来自当前班级详情，不从平台身份推断助教能力。 */
export type TeachingCapability =
  | 'progress:read'
  | 'submissions:read'
  | 'assignments:manage'
  | 'feedback:write'
  | 'help:manage'
  | 'students:manage';
export interface Classroom {
  id: string;
  domain_id: string;
  name: string;
  description: string;
  stage_tag: string;
  status: 'active' | 'archived';
  revision: number;
  primary_coach_id: string;
}
export interface ClassroomDetail extends Classroom {
  membership: { role: 'coach' | 'assistant' | 'student'; status: string } | null;
  capabilities: TeachingCapability[];
  manages_domain: boolean;
}
export interface Assignment {
  id: string;
  classroom_id: string;
  title: string;
  description: string;
  state: 'draft' | 'scheduled' | 'published' | 'archived';
  revision: number;
  publish_at: string | null;
  published_at: string | null;
  deadline_at: string | null;
  ended_at: string | null;
  archived_at: string | null;
  publish_error: string | null;
  include_previous_submissions: boolean;
}
export type ProgressStatus = 'not_started' | 'judging' | 'below_target' | 'achieved' | 'unavailable';
export interface TeachingCell {
  item_id: string;
  user_id: string;
  status: ProgressStatus;
  score: number | null;
  accepted: boolean;
  updating: boolean;
  late: boolean;
  source_submission_id: string | null;
  source_kind: 'submission' | 'objective' | null;
  evaluated_version_id: string | null;
  policy_revision: number;
}
export interface TeachingItem {
  id: string;
  reference: { display_ref: string; qualified_ref: string };
  problem_id: string;
  binding_id: string;
  requirement: 'accepted' | 'min_score';
  minimum_score: number | null;
  resource_available: boolean;
  answer_version_id: string | null;
  policy_revision: number;
}
export interface MatrixData {
  page: number;
  per_page: number;
  total: number;
  scope: 'on_time' | 'current';
  updating: boolean;
  items: TeachingItem[];
  rows: { user_id: string; username: string; recipient_status: string; cells: TeachingCell[] }[];
}
export interface MyProgress {
  scope: 'on_time' | 'current';
  updating: boolean;
  recipient_status: string;
  items: TeachingItem[];
  cells: TeachingCell[];
}
export interface TeachingText {
  submission_id: string;
  file_name: string;
  text: string;
  source_hash: string;
  line_count: number;
}
export interface LineAnnotation {
  id: string;
  submission_id: string;
  file_name: string;
  source_hash: string;
  start_line: number;
  end_line: number;
  author_id: string;
  author_name?: string;
  body: string;
  revision: number;
  created_at: string;
}
export interface AssignmentFeedback {
  id: string;
  target_user_id: string | null;
  author_id: string;
  author_name: string;
  body: string;
  revision: number;
  created_at: string;
}
export interface AssignmentHelp {
  id: string;
  user_id: string;
  item_id: string | null;
  body: string;
  state: 'open' | 'resolved';
  revision: number;
  replies?: { id: string; author_name: string; body: string; created_at: string }[];
  reply_page?: number;
  reply_total?: number;
}
export interface TeachingPage<T> {
  data: T[];
  total: number;
  page: number;
  per_page: number;
}

export function classroomCan(detail: ClassroomDetail, capability: TeachingCapability) {
  return detail.manages_domain || detail.membership?.role === 'coach' ||
    detail.membership?.role === 'assistant' && detail.capabilities.includes(capability);
}
/** 缓存包含使用域、查看者和资源／筛选，不依赖上次使用域。 */
export function educationCacheKey(slug: string, actor: string | null, ...resources: unknown[]) {
  return `education:${JSON.stringify([slug, actor, ...resources])}`;
}
export const PROGRESS_LABELS: Record<ProgressStatus, string> = {
  not_started: '未开始',
  judging: '评测中',
  below_target: '未达标',
  achieved: '已达标',
  unavailable: '资源不可用',
};
export function teachingCellLabel(cell: TeachingCell) {
  if (cell.updating) return '更新中';
  const status = PROGRESS_LABELS[cell.status];
  return cell.score === null ? status : `${cell.score / 100} · ${status}${cell.late ? ' · 逾期' : ''}`;
}
/** 截止只结束按时统计，不把仍在评测的任务视为成绩永久冻结。 */
export function assignmentPhase(task: Assignment, now = Date.now()) {
  if (task.state === 'draft') return '草稿';
  if (task.state === 'scheduled') return '定时发布';
  if (task.state === 'archived') return '已归档';
  if (task.ended_at) return '已提前结束';
  return task.deadline_at && Date.parse(task.deadline_at) <= now ? '已截止，可继续练习' : '进行中';
}
