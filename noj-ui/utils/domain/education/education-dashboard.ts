import type { Assignment } from './education.ts';

export interface EducationDashboardTask
  extends Pick<Assignment, 'id' | 'title' | 'classroom_id' | 'state' | 'published_at' | 'deadline_at' | 'ended_at'> {
  classroom_name: string;
  summary: {
    total_students: number | null;
    total_items: number;
    achieved_cells: number | null;
    below_target_students: number | null;
    unavailable_items: number;
    updating: boolean;
  };
}
export interface EducationDashboardData {
  assignments: EducationDashboardTask[];
  help_requests: Array<
    {
      id: string;
      assignment_id: string;
      assignment_title: string;
      classroom_id: string;
      classroom_name: string;
      state: 'open' | 'resolved';
      created_at: string;
    }
  >;
  page: number;
  per_page: number;
  total: number;
}
/** 更新中的成绩不作未达标诊断，资源失效始终需要教师处理。 */
export function teachingNeedsAttention(task: EducationDashboardTask) {
  return task.summary.unavailable_items > 0 ||
    (!task.summary.updating && (task.summary.below_target_students ?? 0) > 0);
}
