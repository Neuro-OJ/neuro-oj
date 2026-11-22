/**
 * 演练管理员写入 SQL（纯函数）。
 *
 * 授权事实只有 `users.role`：`roles` / `user_roles` 已随固定角色重构删除，
 * 因此这里直接写用户行，并与 `noj-tests` 的恢复演练夹具保持同一形态。
 */
import {
  DRILL_ADMIN_EMAIL_DOMAIN,
  DRILL_ADMIN_USER,
  DRILL_BCRYPT_HASH,
} from "./plan.ts";

/**
 * 渲染 `seed_drill_admin()` 的 SQL。
 *
 * email_verified 刻意不写：它是后续迁移新增的字段，新 schema 默认 true；
 * 不显式写入才能同时恢复并验收迁移前的历史快照。
 */
export function renderSeedDrillAdminSql(stamp: string): string {
  return [
    "INSERT INTO users (id, username, email, password_hash, created_at, updated_at)",
    `VALUES ('drill-admin-user', '${DRILL_ADMIN_USER}', 'drill-admin@${DRILL_ADMIN_EMAIL_DOMAIN}',`,
    `        '${DRILL_BCRYPT_HASH}', '${stamp}', '${stamp}')`,
    "ON CONFLICT (id) DO NOTHING;",
    "UPDATE users SET role = 'admin' WHERE id = 'drill-admin-user';",
  ].join("\n");
}
