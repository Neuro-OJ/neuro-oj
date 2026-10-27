import { workspacePath } from './workspace.ts';
export type TeachingNoticeType =
  | 'assignment'
  | 'assignment_changed'
  | 'resource_unavailable'
  | 'feedback'
  | 'help'
  | 'help_reply';
export interface TeachingNotice {
  id: string;
  type: TeachingNoticeType;
  assignment_id: string;
  feedback_id: string | null;
  help_id: string | null;
  reply_id: string | null;
  created_at: string;
  read_at: string | null;
}
export interface AssignmentHistoryEntry {
  id: string;
  item_id: string;
  display_ref: string;
  answer_version: number | null;
  policy_mode: 'any' | 'exact';
  policy_revision: number;
  reason: string;
  actor_name: string;
  created_at: string;
}
export const TEACHING_NOTICE_LABELS: Record<TeachingNoticeType, string> = {
  assignment: '收到作业',
  assignment_changed: '作业或题库口径发生变化',
  resource_unavailable: '作业资源暂不可用',
  feedback: '收到作业反馈',
  help: '有学生求助',
  help_reply: '求助收到回复',
};
/** 链接保留使用域，只带稳定定位；进入页面后重新读取内容。 */
export function teachingNoticeTarget(slug: string, notice: TeachingNotice) {
  return {
    path: workspacePath(slug, `assignments/${notice.assignment_id}`),
    query: {
      ...(notice.help_id ? { help: notice.help_id } : {}),
      ...(notice.feedback_id ? { feedback: notice.feedback_id } : {}),
    },
  };
}
