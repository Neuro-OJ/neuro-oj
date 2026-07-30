## Why

Neuro OJ 已完成用户系统、题目管理、提交评测、榜单等基础 OJ 功能（Phase 0-1），但缺少竞赛/考试系统——这是 OJ 平台的核心差异化功能。无竞赛系统意味着平台只能用作日常刷题工具，无法支撑 LMCC 认证考试、算法竞赛等核心场景。当前 Phase 2 在路线图中处于"规划"状态，现在启动实施。

## What Changes

- 新增 **竞赛主表** (`contests`)，支持 ICPC（罚时制）、IOI（实时反馈总分制）、OI（隐藏排名总分制）三种赛制。赛制特定配置（封榜时间、罚时分钟数、排名可见性等）存储在 `config JSONB` 字段中，`type VARCHAR` 字段标识赛制类型，便于后续扩展新赛制而无需变更 schema
- 新增 **竞赛题目关联表** (`contest_problems`)，支持题目排序、标签（A/B/C）、IOI 每题满分配置
- 新增 **竞赛参与者表** (`contest_participants`)，支持公开自由注册 + 管理员手动邀请双模式
- 新增 **竞赛答疑表** (`contest_clarifications`)，支持参赛者提问 + 管理员公开/私下回复（Phase 4）
- **扩展 `submissions` 表** 新增 `contest_id` 列，竞赛提交与该列关联；NULL = 普通提交
- 新增 `contests.affect_global_ranking` 配置项：创建竞赛时选择是否将竞赛 AC 计入个人全局解题统计
- 新增 `contests.freeze_time` 封榜时间（ICPC 专用），封榜后公开排名冻结
- 新增 **竞赛排名计算**：ICPC 罚时排名 + IOI/OI 总分排名，通过原始 SQL 计算
- 新增 **竞赛实时推送**：Redis PubSub 频道 + SSE 端点，推送排名更新和新提交
- 新增 **RBAC 权限**：`contest:create`、`contest:manage`、`contest:participate`
- 新增前端页面：竞赛大厅、竞赛详情、竞赛做题、竞赛排名、管理后台

## Capabilities

### New Capabilities

- `contest-management`: 竞赛 CRUD（管理端 + 公开列表/详情），支持 ICPC/IOI/OI 三种赛制、封榜、公开/密码保护、参与者管理
- `contest-participation`: 用户注册参赛（公开注册 + 邀请制）、竞赛内提交代码、查看自己的竞赛提交
- `contest-ranking`: ICPC 罚时排名（解题数 > 罚时 > 最后 AC 时间）、IOI/OI 总分排名（总分 > 总耗时），封榜期间公开排名冻结

### Modified Capabilities

- `submission-status-tracking`: 提交新增 `contest_id` 字段，竞赛提交遵循不同的可见性规则（竞赛期间仅自己和 admin 可见）
- `ranking`: 全局排行榜需感知 `contests.affect_global_ranking` 配置，选择性排除不计入统计的竞赛提交
- `database-schema`: 新增 4 张表 + submissions 表新增列 + 新索引
- `rbac-core`: 新增 `contest` 资源域 3 个权限，擴展 `PERMISSION_DEFS` 和 seed
- `sse-event-bus`: 新增 `contest:<id>:ranking` 和 `contest:<id>:submission` 频道

## Impact

- **数据库**: 4 张新表 + 1 列扩展 + 6 个新索引（通过 Drizzle 迁移生成）
- **后端路由**: 新增 `src/routes/contests.ts`（~200 行），追加 `src/routes/admin.ts`（~80 行），追加 `src/routes/sse.ts`（~50 行）
- **后端服务**: 新增 `src/services/contests.ts`（~400 行）、`src/services/contest-ranking.ts`（~200 行），扩展 `src/services/submissions-crud.ts`（~20 行）
- **类型定义**: 新增 `src/types/contests.ts`（~100 行），扩展 `src/types/index.ts`（~5 行）
- **事件系统**: 扩展 `src/lib/event-bus.ts` 新增 2 个频道
- **权限**: 扩展 `PERMISSION_DEFS` + `services/seed-rbac.ts`
- **前端**: 新增 5-6 个页面 + 若干组件（Phase 3），复用现有编辑器组件
- **无破坏性变更**: submissions.contest_id 为 NULLable，不影响现有功能
