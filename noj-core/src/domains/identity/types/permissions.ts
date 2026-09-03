/**
 * RBAC 权限名称类型（格式：`resource:action`，如 `"problem:create_p"`）。
 */
export type PermissionName = string;

/**
 * 系统预置权限定义列表。
 * 每个权限包含 resource、action、description，对应 permissions 表。
 */
export const PERMISSION_DEFS: Array<{
  resource: string;
  action: string;
  description: string;
}> = [
  // 管理员全权限通行证（替代 roles.is_admin 语义；权限检查含此权限即视为管理员）
  {
    resource: "admin",
    action: "full_access",
    description: "管理员全权限（隐式拥有所有权限）",
  },
  // 题目
  { resource: "problem", action: "create", description: "创建题目" },
  {
    resource: "problem",
    action: "create_p",
    description: "创建管理题（P 型）",
  },
  { resource: "problem", action: "read", description: "查看题目" },
  { resource: "problem", action: "write_own", description: "编辑自己的题目" },
  { resource: "problem", action: "write_any", description: "编辑任意题目" },
  { resource: "problem", action: "delete_own", description: "删除自己的题目" },
  { resource: "problem", action: "delete_any", description: "删除任意题目" },
  {
    resource: "problem",
    action: "package_manage_own",
    description: "管理自己题目的支持包",
  },
  {
    resource: "problem",
    action: "package_manage_any",
    description: "管理任意题目的支持包",
  },
  {
    resource: "problem",
    action: "field_evaluator_command",
    description: "设置/修改题目评测命令（evaluator.command）",
  },
  {
    resource: "problem",
    action: "field_evaluator_network",
    description: "设置/修改题目评测联网开关（evaluator.network）",
  },
  // 提交
  { resource: "submission", action: "create", description: "创建提交" },
  { resource: "submission", action: "read_own", description: "查看自己的提交" },
  {
    resource: "submission",
    action: "read_all",
    description: "查看所有提交（含代码）",
  },
  { resource: "submission", action: "rejudge", description: "触发重测" },
  // 用户
  { resource: "user", action: "read_profile", description: "查看用户主页" },
  { resource: "user", action: "search", description: "搜索用户" },
  {
    resource: "user",
    action: "manage",
    description: "管理用户（封禁/改角色）",
  },
  // 标签
  { resource: "tag", action: "read", description: "查看标签" },
  {
    resource: "tag",
    action: "manage",
    description: "管理标签（创建/修改/删除/合并）",
  },
  // 竞赛
  { resource: "contest", action: "create", description: "创建竞赛" },
  {
    resource: "contest",
    action: "manage",
    description: "管理任意竞赛（编辑、删除、参与者管理）",
  },
  { resource: "contest", action: "participate", description: "参加竞赛" },
  // 社区内容与互动
  { resource: "community", action: "read", description: "查看社区内容" },
  { resource: "community", action: "create_solution", description: "发布题解" },
  {
    resource: "community",
    action: "create_discussion",
    description: "发布讨论",
  },
  { resource: "community", action: "create_moment", description: "发布动态" },
  { resource: "community", action: "comment", description: "发表评论" },
  { resource: "community", action: "react", description: "点赞和收藏社区内容" },
  { resource: "community", action: "follow", description: "关注社区用户" },
  { resource: "community", action: "report", description: "举报社区内容" },
  // 社区治理
  {
    resource: "community_moderation",
    action: "review",
    description: "审核社区内容",
  },
  {
    resource: "community_moderation",
    action: "hide",
    description: "隐藏或恢复社区内容",
  },
  {
    resource: "community_moderation",
    action: "lock",
    description: "锁定或置顶社区内容",
  },
  {
    resource: "community_moderation",
    action: "sanction",
    description: "管理社区处罚",
  },
  {
    resource: "community_board",
    action: "manage",
    description: "管理社区板块",
  },
  // 题单（training）
  { resource: "training", action: "create", description: "创建题单" },
  { resource: "training", action: "read", description: "查看题单" },
  { resource: "training", action: "read_any", description: "查看任意题单" },
  { resource: "training", action: "write_own", description: "编辑自己的题单" },
  { resource: "training", action: "write_any", description: "编辑任意题单" },
  { resource: "training", action: "delete_own", description: "删除自己的题单" },
  { resource: "training", action: "delete_any", description: "删除任意题单" },
  { resource: "training", action: "publish", description: "将题单设为公开" },
  { resource: "training", action: "pin", description: "置顶题单" },
  // 公告
  { resource: "announcement", action: "manage", description: "管理公告" },
  // 系统
  { resource: "system", action: "settings", description: "系统设置" },
  { resource: "system", action: "judge_images", description: "管理评测镜像" },
  { resource: "system", action: "audit_logs", description: "查看审计日志" },
  { resource: "system", action: "ip_bans", description: "管理 IP 黑名单" },
];
