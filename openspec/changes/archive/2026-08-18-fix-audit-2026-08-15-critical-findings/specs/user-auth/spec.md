## ADDED Requirements

### Requirement: JWT 算法与实时状态检查
JWT 验证 SHALL 固定 HS256；认证中间件 MUST 对封禁用户拒绝读写请求，且不得信任 JWT 中的静态 role 作为 RBAC 或客观题权限依据。

#### Scenario: 封禁用户旧 JWT 访问
- **WHEN** 用户被封禁后携带既有 JWT 请求
- **THEN** 认证失败并返回 403/401

### Requirement: 高风险端点限流
注册、忘记/重置密码、私信发送与提交创建端点 SHALL 实施 IP 或用户维度速率限制。

#### Scenario: 高频注册
- **WHEN** 同一 IP 在窗口内超过注册限制
- **THEN** 服务端返回 429，不创建账号
