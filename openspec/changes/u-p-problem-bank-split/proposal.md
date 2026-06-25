## Why

当前 Neuro OJ 的题目系统仅有 admin/user 二元角色划分，所有题目的增删改仅限管理员。缺乏题目类型区分和所有权概念，无法支持用户创建自己的题目或对题目按类型独立管理。需要建立 U（用户题库）和 P（主题库）双题库体系，引入题目所有者机制，实现更灵活的权限管控。

## What Changes

- **题目表新增字段**：`owner_id`（所有者）、`type`（U/P 类型）、`number`（题号，每个 type 独立自增 INTEGER）
- **题目类型双题库**：U 型（用户题库，所有者享有全部 CRUD）、P 型（主题库，仅管理员可写，所有人可读）
- **题号独立编号**：U 和 P 各自的题号独立自增，对外显示为 `{type}{number}`（如 `P1001`、`U42`）
- **权限模型重构**：从 admin 独占写权限，改为基于 type + owner 的服务层权限判断；ownerMiddleware 不再用于题目路由
- **双索引 URL 路由**：`/api/v1/problems/:id` 同时支持 UUID 和 display_id（如 `P1001`）两种索引格式
- **Root 系统用户**：启动时自动创建 `UID=0` 的 root 用户（admin 角色、密码随机、不可登录、列表中不可见）
- **普通用户可创建 U 型题目**：不再限于管理员，已验证用户可创建 U 型题目并自动成为所有者
- **前端适配**：题目列表新增类型筛选、display_id 展示、编辑/删除按钮权限控制、用户个人题目管理页
- Seed 脚本同步更新样例题为 P 型归 root 所有

## Capabilities

### New Capabilities
- `problem-ownership`: 题目所有权机制，支持按 type + owner 的权限判断、题号自增、双索引路由查找

### Modified Capabilities
- `problem-management`: 题目 CRUD 的权限模型从「仅 admin」改为基于 type + owner 的细粒度控制；创建/更新/删除路由均移除 adminMiddleware；列表新增 type、number 筛选
- `database-schema`: problems 表新增 owner_id、type、number 字段及 UNIQUE(type, number) 组合唯一约束
- `admin-authorization`: 题目操作不再独占 adminMiddleware，权限下沉至服务层；新增 root 系统用户概念及其隐藏规则
- `admin-problem-management`: 管理后台题目表格新增 display_id、type、owner 列；创建表单新增类型选择器和题号输入
- `problem-list-page`: 列表新增 type 筛选、display_id 列展示

## Impact

- **noj-core**: 数据库 migration（新字段/约束）、schema/types 定义更新、服务层权限逻辑重写、路由层双索引查找、Root 用户启动创建、Seed 脚本适配
- **noj-ui**: 题目列表/详情/管理页的展示和权限适配；用户个人题目管理的新增页面；筛选组件扩展
- **OpenSpec**: database-schema、problem-management、admin-authorization、admin-problem-management、problem-list-page 五个 spec 的更新 + 新 capability 规范
- **数据库**: 需执行 migration 0004 新增 owner_id/type/number 字段及约束；已有样例题数据迁移为 P 型归 root
