/** 教学权限来自当前域角色，班级名单只包含学生。 */
export type TeachingCapability =
  | 'progress:read'
  | 'submissions:read'
  | 'assignments:manage'
  | 'feedback:write'
  | 'help:manage'
  | 'students:manage';
/** 实际作答入口；成绩候选仍由服务端按同域规则计算。 */
export interface AssignmentSubmissionOrigin {
  assignment_id: string;
  assignment_item_id: string;
}
export interface Classroom {
  id: string;
  domain_id: string;
  name: string;
  description: string;
  stage_tag: string;
  status: 'active' | 'archived';
  revision: number;
}
export interface ClassroomDetail extends Classroom {
  membership: { role: 'student'; status: string } | null;
  capabilities: TeachingCapability[];
  manages_domain: boolean;
  historical_student?: boolean;
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
  submission_source: 'assignment_only' | 'domain_any';
  include_previous_submissions: boolean;
}
export interface ClassroomMember {
  id: string;
  user_id: string;
  username: string;
  role: 'student';
  status: 'active' | 'removed';
  effective_active: boolean;
  capabilities?: TeachingCapability[];
}
export interface AssignmentDraftInput {
  title: string;
  description: string;
  deadline_at: string | null;
  submission_source: 'assignment_only' | 'domain_any';
  include_previous_submissions: boolean;
  target_student_ids: string[] | null;
  items?: {
    binding_id: string;
    requirement: 'accepted' | 'min_score';
    minimum_score: number | null;
  }[];
  training?: {
    id: string;
    requirement: 'accepted' | 'min_score';
    minimum_score: number | null;
  };
}
export interface AssignmentDetail extends Assignment {
  target_student_ids?: string[] | null;
  source_training_id: string | null;
  source_training_rule: {
    requirement: 'accepted' | 'min_score';
    minimum_score: number | null;
  } | null;
  items: {
    id: string;
    binding_id: string;
    requirement: 'accepted' | 'min_score';
    minimum_score: number | null;
    reference: { display_ref: string; qualified_ref: string };
    answer_version_id: string | null;
    policy_revision: number | null;
  }[];
}
export interface TeachingProblemOption {
  binding_id: string;
  title: string;
  kind: string;
  version: number;
  reference: { display_ref: string; qualified_ref: string };
}
export const TEACHING_CAPABILITY_LABELS: Record<TeachingCapability, string> = {
  'progress:read': '查看学情',
  'submissions:read': '查看学生提交',
  'assignments:manage': '创建和管理作业',
  'feedback:write': '撰写反馈',
  'help:manage': '处理求助',
  'students:manage': '管理学生成员',
};

/** 显示分精确转为 ×100 整数，不把三位小数静默舍入为另一项达标要求。 */
export function teachingScore(value: string | number) {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(String(value).trim());
  if (!match) throw new Error('最低分需要 0–100，最多两位小数');
  const score = Number(match[1]) * 100 +
    Number((match[2] ?? '').padEnd(2, '0'));
  if (score > 10000) throw new Error('最低分不能超过 100');
  return score;
}
/** 表单在客户端按用户时区编辑，接口统一使用 UTC。 */
export function teachingLocalTime(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso), two = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}
export function teachingUtcTime(local: string) {
  if (!local) return null;
  const date = new Date(local);
  if (!Number.isFinite(date.getTime())) throw new Error('时间格式错误');
  return date.toISOString();
}
/** 题单链接提取稳定资源标识，执行始终使用当前目标域。 */
export function teachingTrainingId(value: string) {
  const input = value.trim();
  if (!input) throw new Error('请选择题单或粘贴题单链接');
  if (!input.includes('/')) return input;
  const url = new URL(input, 'https://noj.local');
  const match = /^\/d\/[a-z0-9-]+\/trainings\/([^/]+)\/?$/.exec(url.pathname);
  if (!match) throw new Error('请使用带空间的题单链接');
  return decodeURIComponent(match[1]!);
}
export type ProgressStatus =
  | 'not_started'
  | 'judging'
  | 'below_target'
  | 'achieved'
  | 'unavailable';
export interface TeachingCell {
  can_read_code?: boolean;
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
  contest_protection?: Array<
    { contestId: string; publicId: string; title: string }
  >;
  can_read?: boolean;
  can_practice?: boolean;
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
  rows: {
    user_id: string;
    username: string;
    recipient_status: string;
    cells: TeachingCell[];
  }[];
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
  target_name?: string | null;
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
  replies?: {
    id: string;
    author_name: string;
    body: string;
    created_at: string;
  }[];
  reply_page?: number;
  reply_total?: number;
}
export interface TeachingPage<T> {
  data: T[];
  total: number;
  page: number;
  per_page: number;
}

export function classroomCan(
  detail: ClassroomDetail,
  _capability: TeachingCapability,
) {
  return detail.manages_domain;
}
/** 缓存包含使用域、查看者和资源／筛选，不依赖上次使用域。 */
export function educationCacheKey(
  slug: string,
  actor: string | null,
  ...resources: unknown[]
) {
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
export function assignmentPhase(
  task: Pick<Assignment, 'state' | 'ended_at' | 'deadline_at'>,
  now = Date.now(),
) {
  if (task.state === 'draft') return '草稿';
  if (task.state === 'scheduled') return '定时发布';
  if (task.state === 'archived') return '已归档';
  if (task.ended_at) return '已提前结束';
  return task.deadline_at && Date.parse(task.deadline_at) <= now ? '已截止，可继续练习' : '进行中';
}
