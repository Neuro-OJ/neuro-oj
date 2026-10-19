/** 批量操作始终仅生成学生身份或邮箱邀请，不包含账号创建。 */
export type ClassroomImportAction =
  | 'join'
  | 'invite'
  | 'replace_invite'
  | 'already_member'
  | 'already_invited'
  | 'error';
export interface ClassroomImportRow {
  row: number;
  email: string;
  username: string;
  matched_username: string | null;
  user_id: string | null;
  action: ClassroomImportAction;
  error?: string;
  invitation_ids: string[];
  invitation_id?: string;
  expires_at?: string;
  token?: string;
}
export interface ClassroomImportSummary {
  total: number;
  join: number;
  invite: number;
  skipped: number;
  errors: number;
}
export interface ClassroomImportPreview {
  revision: number;
  preview_hash: string;
  rows: ClassroomImportRow[];
  summary: ClassroomImportSummary;
}
export interface ClassroomImportResult {
  replayed: boolean;
  rows: ClassroomImportRow[];
  summary: ClassroomImportSummary;
}
export interface ClassroomJoinRequest {
  id: string;
  user_id: string;
  username?: string;
  user?: import('./user-identity').UserSummary;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
}
export interface ClassroomJoinView {
  classroom_id: string;
  name: string;
  status: 'active' | 'archived';
  is_member: boolean;
  can_apply: boolean;
  request: ClassroomJoinRequest | null;
}
export const CLASSROOM_IMPORT_LABELS: Record<ClassroomImportAction, string> = {
  join: '加入班级',
  invite: '生成邀请',
  replace_invite: '撤销旧链接并重签',
  already_member: '已是学生',
  already_invited: '已有有效邀请',
  error: '不执行',
};
/** CSV 输出防止电子表格将账号字段当成公式，不保存或恢复缺失的邀请令牌。 */
export function classroomImportResultCsv(rows: ClassroomImportRow[], invitationLink: (token: string) => string) {
  const cell = (value: string) => `"${(/^[=+\-@\t\r]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;
  const records = rows.map(
    (r) => [
      String(r.row),
      r.email,
      r.matched_username ?? r.username,
      CLASSROOM_IMPORT_LABELS[r.action],
      r.error ?? '',
      r.token ? invitationLink(r.token) : '',
    ],
  );
  return '\uFEFF' +
    [['行', '邮箱', '用户名', '处理结果', '说明', '首次邀请链接'], ...records].map((r) => r.map(cell).join(',')).join(
      '\r\n',
    );
}
