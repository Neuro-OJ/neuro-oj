## Why

当前 Neuro OJ 在全新部署后**没有任何可登录的管理员账号**：`scripts/seed.ts`
的 `ensureAdminFromEnv()` 检测不到 `ADMIN_EMAIL` 环境变量时静默 return；唯一存在
的是 `ensureRootUser()` 启动时创建的 `root` 系统用户（id=`0`，密码随机不可登录）。
结果就是新部署的实例 `/admin` 后台完全进不去，用户只能通过修改数据库 SQL 手
动提权，体验断层。

即使补上"自动创建引导管理员"也存在凭证泄露风险——临时密码会打印到终端，
可能被日志系统收录、旁观者看到；如果不强制首次登录修改密码，凭据泄露窗口期
不可控。

## What Changes

- **数据库层**：`users` 表新增 `must_change_password BOOLEAN NOT NULL DEFAULT false` 字段
- **种子脚本**：新增 `ensureBootstrapAdmin()`，当且仅当不存在"可登录 admin"时
  自动创建一个临时管理员（username=`admin`, email=`admin@noj.local`,
  24 字符 base64url 随机密码），并设置 `must_change_password=true`；终端以醒
  目格式打印临时凭证
- **JWT 负载扩展**：新增 `must_change_password: boolean` claim，与 DB 列名对齐
- **认证中间件拦截**：`requireAuth` 在 JWT 的 `must_change_password=true` 时拒绝
  除白名单（`/api/v1/auth/change-password`、`/api/v1/auth/me`、`/api/v1/auth/logout`）
  外的所有受保护路径，返回 HTTP 403 + `code: PASSWORD_CHANGE_REQUIRED`
- **修改密码端点**：新增 `POST /api/v1/auth/change-password`，复用注册时强度
  规则（≥12 位 / 含大小写+数字），需校验 `old_password`，成功后清字段
- **前端路由守卫**：检测 `must_change_password` 时强制跳转 `/change-password`
- **前端改密页**：新增 `pages/ChangePassword.vue`（强制两栏：新密码 + 确认密码）
- **登录响应分流**：`useAuth` 登录成功后根据 `must_change_password` 分流跳转
- **文档补充**：README/AGENTS.md 描述引导管理员流程与强制改密机制

## Capabilities

### New Capabilities

- `admin-bootstrap-and-force-password-change`: 自动创建引导管理员、强制首次改密、
  中间件拦截、白名单路由、改密端点、前端配套路由守卫

### Modified Capabilities

- `admin-authorization`: 种子脚本新增 `ensureBootstrapAdmin()`；移除
  `ensureAdminFromEnv()` 静默跳过路径；新增 `must_change_password` 字段及强制改密要求
- `user-auth`: JWT payload 新增 `must_change_password` claim；`loginUser()` 写入该
  claim；新增 `POST /api/v1/auth/change-password` 端点；`getUserProfile()` 返回
  `must_change_password`
- `database-schema`: `users` 表新增 `must_change_password` 布尔字段

## Impact

- **noj-core**: 数据库 migration（0006 新字段）、schema 追加列、JWT 类型扩
  展、auth 服务新增 `changePassword()`、中间件新增白名单拦截逻辑、seed 脚本
  新增 `ensureBootstrapAdmin()`、路由新增 `POST /api/v1/auth/change-password`
- **noj-ui**: `User` 类型加 `must_change_password`；`useAuth` 登录分流；中间
  件 `auth.ts` 路由守卫；新建 `pages/ChangePassword.vue`；登录页与导航适配
- **OpenSpec**: `admin-authorization`、`user-auth`、`database-schema` 三个
  spec 的增量 + 新 capability 规范
- **数据库**: 需执行 migration 0006 新增 `must_change_password` 列；存量用户
  默认 `false`，不影响现有登录
- **环境**: 无新增环境变量；`ADMIN_EMAIL`/`ADMIN_PASS` 仍可覆盖引导行为（若
  设置则不创建临时管理员，沿用原有逻辑）