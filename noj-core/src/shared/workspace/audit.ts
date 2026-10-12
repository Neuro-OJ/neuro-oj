/** 域治理的合法审计事件，DB 与服务使用同一组静态常量。 */
export const WORKSPACE_AUDIT_ACTIONS = [
  "domain.create",
  "domain.update",
  "domain.status",
  "domain.join",
  "domain.join_review",
  "domain.member_roles",
  "domain.member_remove",
  "domain.transfer",
  "domain.invite_create",
  "domain.invite_accept",
  "domain.invite_revoke",
] as const;
/** 工作空间审计动作类型。 */
export type WorkspaceAuditAction = typeof WORKSPACE_AUDIT_ACTIONS[number];
/** 只由静态白名单构造 SQL 字面量，不接受用户内容。 */
export const WORKSPACE_AUDIT_ACTION_SQL = WORKSPACE_AUDIT_ACTIONS.map((
  action,
) => `'${action}'`).join(", ");
