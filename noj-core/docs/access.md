# 权限与鉴权（noj-core）

> 平台与域内角色都只有固定取值；能力映射是静态表，不存在 RBAC 表。角色列与 CHECK
> 约束见 [`database.md`](./database.md#3-schema-关键约定)。

## 1. 固定角色

平台角色仅 `user` / `admin`；域内角色仅 `member` / `educator` / `admin`。

| 事实                      | 用途                     |
| ------------------------- | ------------------------ |
| `users.role`              | 平台角色，单值列 + CHECK |
| `domain_memberships.role` | 域内角色，单值列 + CHECK |
| `domains.owner_id`        | 域负责人，优先于成员角色 |

能力名按 `<resource>:<action>`（如 `problem:write_any`、`system:settings`）。
完整清单是
[`../src/modules/access/identity/services/security/permissions.ts`](../src/modules/access/identity/services/security/permissions.ts)
的静态表；新增能力改表，不要引入权限表。

## 2. 检查层次

共享请求级缓存，按入口选守卫：

- `requireAdmin()`：纯 JWT fast path，用于 `/api/v1/admin/*` 路由组。
- `requirePermission("x")`：平台能力守卫，只用于平台级端点。
- `checkPermission` / `assertPermission`：handler/service 内部条件判断或断言。
- `assertWorkspacePermission(...)`
  （`../src/modules/access/workspace/services/access.ts`）：域内授权唯一入口；
  域内权限不得用 `checkPermission` 代替。

## 3. 会话与 JWT

- HS256；校验 `iss` / `aud`；24 小时过期，无刷新。
- `jti` 对照 Redis 撤销记录；`session_version` 与用户表实时比较。
- 改密 / 重置密码时原子递增版本，使旧会话失效。
- 签发必须使用「凭据校验时读到的版本」；不得在校验后重新读取版本，给旧凭据
  续权。

## 4. 密码与账号防护

- 密码重置：DB 存 SHA-256 哈希，TTL 15 分钟，单 SQL 原子消耗。
- 强制改密守卫：`token.must_change_password` 为真时，除白名单外全部返回 403
  `PASSWORD_CHANGE_REQUIRED`。
- 用户枚举防护：登录失败统一返回「用户名或密码错误」；`forgot-password` 恒返
  200。
- Root 用户 UID 为 `"0"`，随机密码不可登录，不计入管理员统计。
