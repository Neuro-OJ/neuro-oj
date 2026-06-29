-- 修复 issue #75：为 users 表添加 must_change_password 标志
--
-- 含义：true 表示用户必须在下一次登录后立即修改密码（引导管理员、
-- ADMIN_EMAIL/ADMIN_PASS 创建的初始账号等场景）。
-- authMiddleware 在 token 携带该标志且请求路径不在白名单内时
-- 直接返回 403 PASSWORD_CHANGE_REQUIRED。
--
-- 默认 false：历史用户不受影响，前向兼容。
-- NOT NULL + DEFAULT false：未来即使忘记显式写入，DB 也能给出安全值。

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_change_password boolean NOT NULL DEFAULT false;