## Context

当前管理后台后端 API 分散在 `routes/auth.ts`（用户列表、角色管理）和 `routes/submissions.ts`（提交列表）中，缺乏统一的 admin 路由组织。仪表盘统计接口完全缺失；题目管理缺少管理员专属的全量列表（当前 `GET /api/v1/problems` 默认仅返回 P 型题目）；用户管理缺少搜索、筛选和编辑用户资料的能力。

六个现有的 admin spec 描述了管理功能需求，但后端实现存在缺口：
- `admin-dashboard` → 无后端统计接口
- `admin-problem-management` → 无管理员专属题目列表端点
- `admin-user-management` → 用户列表缺少搜索/筛选参数
- `admin-submission-management` → 缺少提交详情查看和删除端点

## Goals / Non-Goals

**Goals:**
- 新增仪表盘统计数据 API：聚合用户数、题目数、提交数、评测通过率等关键指标
- 新增管理员专属题目列表 API：显示所有类型（U+P），支持与普通列表相同的筛选参数
- 增强管理员用户列表 API：添加 username/email 搜索、role 筛选、注册日期范围筛选
- 新增管理员编辑用户 API：允许管理员更新任意用户的 email、bio 等 profile 字段
- 新增管理员提交详情 API：查看任意提交的完整详情（含源代码）
- 新增管理员提交删除 API：删除违规/测试提交记录
- 将管理路由统一组织到 `routes/admin.ts`，保持挂载模式的一致性

**Non-Goals:**
- 不涉及管理员登录/认证机制的变更
- 不涉及用户名修改（会影响提交历史关联和认证流程）
- 不涉及评测队列的管理操作（暂停/取消/重排）
- 不涉及系统配置的动态修改
- 不涉及审计日志功能
- 不涉及批量操作端点

## Decisions

### Decision 1：统一管理路由组织结构

**决策：** 创建 `routes/admin.ts`，将现有的 admin 端点和新增端点集中管理。

`routes/admin.ts` 使用 `adminMiddleware` 作为路由组级别中间件（通过 `router.use(authMiddleware, adminMiddleware)` 一次性应用到所有子路由），减少每个处理程序中的重复中间件声明。

现有 auth.ts 中的 `adminAuth` 路由和 submissions.ts 中的 `adminSubmissions` 路由迁移到 admin.ts 后删除，保持 `auth.ts` 仅包含认证相关端点。

**理由：**
- 当前 admin 端点分散在 3 个文件中，新开发者难以快速找到所有管理端点
- 统一管理后，权限和安全审计更清晰——只需检查 `admin.ts` 即可
- 路由组级别中间件减少重复代码

### Decision 2：仪表盘统计接口——多查询聚合

**决策：** `GET /api/v1/admin/dashboard/stats` 在服务层中执行 4 次独立 SQL 查询（用户统计、题目统计、提交统计、队列统计），服务层聚合后返回。

**不选用** 单条巨型 SQL 的原因：各统计维度来自不同的表（users、problems、submissions），单条 SQL 的 CROSS JOIN 会膨胀中间结果集，在数据量大时反而更慢。4 次独立查询均在主键/索引上执行，每次为 O(log N)，总耗时可忽略。

### Decision 3：管理员题目列表——新增独立服务函数

**决策：** 在 `services/problems.ts` 中新增 `listAllProblems()` 函数，与现有 `listProblems()` 相比：
- 不默认添加 `type = 'P'` 筛选条件
- 额外返回 `owner_username` 字段（JOIN users 表）
- 不返回 `description` 字段（列表场景不需要，减少传输量）

**理由：** 现有 `listProblems()` 的 `conditions.push(eq(problems.type, 'P'))` 是默认行为，若直接修改会破坏公共 API 行为。新增独立函数避免回归风险。

### Decision 4：用户搜索——可选参数模式

**决策：** 在现有 `listUsers()` 的基础上扩展参数，新增可选参数 `keyword`（搜索 username 和 email）、`role`（按角色筛选）、`from`/`to`（注册日期范围）。所有参数均为可选，不传时行为与当前一致（向后兼容）。

### Decision 5：提交详情与删除

**决策：** 
- `GET /api/v1/admin/submissions/:id` 复用现有的 `getSubmission()` 服务函数，但跳过 `userId` 所有权检查（传入空字符串或内部使用管理员标记）
- `DELETE /api/v1/admin/submissions/:id` 新增服务函数 `deleteSubmission()`，仅 admin 可调用，硬删除提交记录及关联的评测结果

### Decision 6：管理员编辑用户资料

**决策：** `PUT /api/v1/admin/users/:id` 端点允许管理员编辑任意用户的 profile，接受可选字段 `email` 和 `bio`（至少提供一个）。复用现有 `services/users.ts` 中的 `updateUserProfile()` 服务函数（需扩展支持 email 更新），或新增 `adminUpdateUserProfile()` 函数。

**关键点：**
- 管理员编辑用户时绕过 bio 长度限制和所有权的概念（管理员有权修改任意用户）
- 邮箱修改需唯一性检查，复用现有冲突检查逻辑
- 防枚举保护：统一返回 "用户不存在" 而非区分 "用户不存在" vs "邮箱已被注册"
- 端点受 `authMiddleware` + `adminMiddleware` 保护

**理由：**
- 复用现有 updateUserProfile 逻辑减少重复代码，仅在服务层增加 role 参数区分管理员调用
- 邮箱唯一性检查已有现成的 ConflictError 抛出机制

## Risks / Trade-offs

- **提交详情 API 绕过所有权检查** → 现有 `getSubmission()` 逻辑中 `if (userId && row.user_id !== userId)` 的检查可以通过 `userId = undefined` 来跳过。需要确保 admin 路由不会意外泄露非管理员能访问的信息。Mitigation：仅在 admin 路由中使用此绕过方式，且端点受 `adminMiddleware` 保护。
- **管理员题目列表暴露 U 型题目** → U 型题目本意是用户私有题库，管理员全量列表可能让非所有者看到。Mitigation：符合预期——管理员本身就需要监管所有题目，当前 admin-problem-management spec 也要求管理员能管理所有题目。
- **无分页硬限制的删除操作** → 不涉及，每次删除为单条记录操作。
- **仪表盘统计在高并发下压力** → 统计查询均为索引扫描，百万级数据量下每次查询 < 50ms。若后续成为瓶颈可引入 Redis 缓存，但当前阶段不需要。
