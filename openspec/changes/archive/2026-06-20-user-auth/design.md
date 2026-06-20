## Context

noj-core 已具备 `users` 表（PostgreSQL + Drizzle ORM）、数据库连接单例和 Redis
连接。当前仅有 `/health` 端点，无任何认证机制。Issue #4
需要在此基础上实现完整的用户注册/登录/JWT 认证系统。

**约束：**

- 运行环境为 Deno，所有依赖必须是纯 JS（无原生模块）
- 遵循项目约定：中文注释、Hono 子路由导出默认实例、`/api/v1` 前缀
- 所有提交必须 GPG 签名

## Goals / Non-Goals

**Goals:**

- 用户可通过 REST API 注册账号（用户名 + 邮箱 + 密码）
- 用户可通过用户名或邮箱登录，获取 JWT
- 受保护端点可通过 Bearer token 获取当前用户信息
- 密码使用 bcrypt 哈希存储，不可逆
- 统一的错误处理（AppError 类层次）

**Non-Goals:**

- 角色权限控制（RBAC）—— 表中有 `role` 字段但本次不实现授权逻辑
- Token 刷新、撤销、黑名单
- 密码重置、邮箱验证
- 速率限制、暴力破解防护

## Decisions

### 1. 密码哈希：bcryptjs 而非 Web Crypto PBKDF2

**选择**: `npm:bcryptjs@^2.4.3` **理由**:

- 纯 JavaScript，Deno 零配置可用
- 业界标准格式（`$2a$`），与其他语言/系统互通
- 内置 salt 生成，无需自行管理

**备选**: Web Crypto API 的 `SubtleCrypto.deriveBits()`（PBKDF2）

- 优点：零依赖，Deno 原生
- 缺点：需要手动管理 salt、迭代次数、哈希格式，增加实现复杂度和出错风险

### 2. JWT：jose 而非 hono/jwt

**选择**: `npm:jose@^5` **理由**:

- 独立库，API 稳定，Deno 兼容性好
- 支持 `SignJWT` 和 `jwtVerify` 清晰的两阶段 API
- 内置多种算法支持（HS256 满足当前需求）
- 过期时间等标准声明（`iat`、`exp`、`sub`）原生支持

**备选**: Hono 内置 `hono/jwt` 辅助

- 优点：与 Hono 集成更紧密
- 缺点：功能受限，实际上底层也依赖 jose；独立使用 `jose` 更灵活

### 3. 签名算法：HS256（对称密钥）

**选择**: HS256 **理由**:

- 单服务架构下对称密钥足够（noj-core 同时签发和验证）
- 密钥管理简单（一个环境变量 `JWT_SECRET`）
- 性能优于非对称算法（RS256/ES256）
- 未来可升级到 RS256 支持多服务验证

### 4. 用户枚举防护

**选择**: 登录失败时统一返回
`"用户名或密码错误"`，不区分"用户不存在"和"密码错误"

**理由**: 防止攻击者通过错误消息差异枚举已注册用户。这是 OWASP 推荐的标准做法。

### 5. 错误处理架构

**选择**: `AppError` 基类 + HTTP 状态码子类

```
AppError
├── ConflictError (409)
├── UnauthorizedError (401)
└── ValidationError (400)
```

**理由**:

- 服务层抛出语义化错误，路由层统一捕获转换
- 避免在每个处理程序中重复 try/catch + 状态码映射
- `app.onError()` 全局处理程序兜底未预期的错误

### 6. 输入验证位置

**选择**: 验证逻辑内联在路由处理程序中，不创建独立验证文件

**理由**:

- 当前仅有 3 个端点，验证逻辑简单（用户名格式、邮箱格式、密码长度）
- 避免过早抽象——独立验证层在仅 3 个端点时引入不必要的间接性
- 当端点数量增长到 10+ 时可重构

## Risks / Trade-offs

- **[Risk] `bcryptjs` 同步 API** → 在请求处理中同步哈希（约
  100ms），对单用户场景可接受；高并发时可用 `Promise.resolve()` 包装为非阻塞模式
- **[Risk] 无密钥轮换** → Phase 0 阶段单密钥足够；密钥泄露时更换 `JWT_SECRET`
  即可使所有旧令牌失效
- **[Risk] 无认证令牌存储** →
  令牌仅在客户端管理，服务端无状态；令牌一旦签发无法主动撤销（Phase 1 解决）
- **[Risk] JWT_SECRET 未设置** → 启动时不检查（仅在首次 JWT 操作时报错）；可在
  `src/lib/jwt.ts` 首次调用时验证并抛出明确错误

## Open Questions

<!-- 无待解决问题 -->
