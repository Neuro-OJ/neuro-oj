/**
 * 判断用户是否为管理员。
 * 优先使用 is_admin 字段，向后兼容 role 字段。
 */
export function isAdminUser(
  user: { is_admin?: boolean; role?: string } | null | undefined,
): boolean {
  return user?.is_admin ?? user?.role === 'admin';
}
