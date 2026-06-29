## Context

当前 Neuro OJ 题目系统仅有 admin/user 二元角色划分，所有题目 CRUD 仅限管理员。
`problems` 表缺少所有者、类型、独立题号字段。需要建立 U/P 双题库体系，引入题
目所有权机制，支持普通用户创建 U 型题目并享有全部 CRUD 权限。

## Goals / Non-Goals

**Goals:**
- 数据库层：problems 表新增 owner_id、type、number 字段及 UNIQUE(type, number) 约束
- Root 系统用户（UID=0）启动时自动创建（admin 角色、随机密码、不可登录、列表隐藏）
- U 型题目：所有者享有全部 CRUD，非所有者只读
- P 型题目：仅管理员可写，所有人可读
- 题号：每个 type 独立 INTEGER 自增，对外显示为 `{type}{number}`（如 P1001）
- API `/api/v1/problems/:id` 双索引：UUID 和 display_id（如 P1001）均可解析
- 前端适配：列表筛选、display_id 展示、权限按钮控制、用户个人题目管理页
- OpenSpec 规范同步更新

**Non-Goals:**
- 不涉及 noj-judge 评测 Worker 的改动
- 不涉及 Redis 消息队列的改动
- 不涉及题目分类体系的改动
- 不涉及用户注册/登录流程的改动

## Decisions

### 1. 新增 number 字段而非复用 id 作为题号
- **选择**：保留 id（UUID）作为内部主键，新增 INTEGER number 字段作为对外题号
- **理由**：
  - submissions 等表的 FK 引用 id，若更改 id 格式需大量迁移
  - UUID 作为内部引用更健壮，number 作为外部标识更可读
  - `UNIQUE(type, number)` 确保 U/P 各自独立编号
  - INTEGER 比 TEXT 更高效（排序、MAX 聚合、索引）

### 2. 题号自增采用 MAX+1 而非数据库序列
- **选择**：`SELECT COALESCE(MAX(number), 0) + 1 FROM problems WHERE type = ?`
- **理由**：
  - 题目创建是低频操作（人手动操作），无并发压力
  - 不需要维护额外的序列对象
  - `UNIQUE(type, number)` 约束兜底并发冲突

### 3. 权限判断下沉至服务层而非中间件
- **选择**：移除路由层 adminMiddleware，在 services/problems.ts 中根据 userRole + owner_id + type 做权限判断
- **理由**：
  - 权限逻辑依赖题目数据（type、owner_id），需要查库后才能决定
  - 中间件适合做「是否登录」「是否 admin」这种无状态检查
  - 服务层更适合做「能否编辑这道题」这种有状态判断

### 4. 双索引路由解析
- **选择**：`:id` 路由参数同时支持 UUID 和 `{type}{number}` 解析
- **理由**：
  - 新旧链接兼容：已经存在的引用 UUID 的链接不失效
  - 用户新分享的 `P1001` 格式链接可直接使用
  - 先尝试 UUID 查找 → 未命中则正则解析 display_id → 组合唯一索引查找
  - 将公共解析逻辑抽取为 `resolveProblem(id)` 工具函数，避免重复

### 5. Root 用户 UID=0 采用固定 ID 而非 UUID
- **选择**：使用 `id='0'` 作为 root 用户的固定标识
- **理由**：
  - 和所有其他用户（UUID v4）格式不同，零碰撞风险
  - 代码中硬编码 `'0'` 可用于默认 owner_id，语义清晰
  - 无需额外的配置或环境变量

### 6. type 字段使用单字母 U/P
- **选择**：`'U'` / `'P'` 两个值，CHAR 语义
- **理由**：简洁；display_id 短（P1001 而非 Official-1001）；后续扩展可加更多单字母

## Risks / Trade-offs

- **并发创建撞号**：`MAX+1` 在极罕见的高并发下可能撞号 → `UNIQUE(type, number)` 约束兜底，插入失败时重试即可
- **Root 用户密码随机丢失**：root 默认不可登录，若有需要恢复管理权限的场景 → seed 脚本仍保留 `ADMIN_EMAIL` / `ADMIN_PASS` 环境变量创建可登录管理员的路径
- **现有样例题 id 不是 UUID**：seed 脚本使用 `"1001"` 等字符串 id，不是 UUID 格式 → 双索引查找按 UUID 解析失败后会 fallback 到 display_id 匹配，兼容这些历史数据
- **前端 URL 迁移**：旧链接使用 UUID 格式的 URL → 双索引保证旧链接不失效，渐进过渡
