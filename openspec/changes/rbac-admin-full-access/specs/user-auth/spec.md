## ADDED Requirements

### Requirement: JWT 不携带权限快照

JWT 负载 SHALL NOT 包含 `is_admin` 或权限集合类 claim。管理员/权限判定 SHALL 由中间件通过 `resolvePermissions`（请求级缓存）实时查询数据库权限集完成，权限变更即时生效，无需重新登录。

JWT 负载中的 `role` claim SHALL 仅用于审计日志（`actorRole`）与展示，不具备任何权限判定语义。

#### Scenario: 签发 JWT 不含 is_admin

- **WHEN** `loginUser()` 为任意用户签发 JWT
- **THEN** JWT payload 不包含 `is_admin` 字段

#### Scenario: 权限变更无需重新登录生效

- **WHEN** 管理员移除某用户的 `admin:full_access` 权限，该用户使用既有 JWT 发起请求
- **THEN** `requireAdmin()` 基于实时权限查询返回 403，旧 token 中的任何 `is_admin` claim 均被忽略
