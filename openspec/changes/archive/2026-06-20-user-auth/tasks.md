## 1. 依赖与基础设施

- [x] 1.1 在 `deno.json` 中添加 `bcryptjs` 和 `jose` 依赖

## 2. 共享类型与工具

- [x] 2.1 创建 `src/lib/errors.ts` — AppError 基类及 ConflictError、UnauthorizedError、ValidationError 子类
- [x] 2.2 创建 `src/types/auth.ts` — RegisterInput、LoginInput、UserResponse 接口

## 3. 密码与 JWT

- [x] 3.1 创建 `src/lib/password.ts` — hashPassword() 和 comparePassword() 函数，封装 bcryptjs
- [x] 3.2 创建 `src/lib/jwt.ts` — signToken() 和 verifyToken() 函数，封装 jose

## 4. 认证中间件

- [x] 4.1 创建 `src/middleware/auth.ts` — JWT Bearer token 验证中间件，提取 userId/userRole 写入上下文

## 5. 业务逻辑

- [x] 5.1 创建 `src/services/auth.ts` — registerUser()、loginUser()、getUserProfile() 函数

## 6. 路由与集成

- [x] 6.1 创建 `src/routes/auth.ts` — POST /register、POST /login、GET /me 三个端点
- [x] 6.2 修改 `src/app.ts` — 挂载 auth 路由，添加全局错误处理
