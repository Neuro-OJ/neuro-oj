# Neuro OJ 前端可读公开标识（Public Identifier）设计

- 日期：2026-08-25
- 状态：已与需求方确认，待用户审阅
- 范围：noj-core + noj-ui 功能变更（含 admin 前端）

## 背景

当前 Neuro OJ 绝大多数实体使用 `crypto.randomUUID()` 作为主键，并在前端 URL、API 路径、列表展示中直接透传完整 UUID。存在以下问题：

- URL 不可读、不便于口头传播与分享：`/submissions/3f2b8c1e-...`
- 列表页只能截断 UUID 前 8 位展示，仍不直观：`#3f2b8c1e`
- 题目已有可读 `display_id`（如 `P1001`），但前端多处仍用 UUID 链接题目，规则不一致。

需求方确认的目标是：**UUID 仅作为内部主键，所有用户可见实体获得稳定的公开标识；前端（含 admin）全面切换，API 保持 UUID 兼容**。

## 2. 目标

- 为竞赛、训练、提交、社区帖子、公告增加不可变 `public_id`。
- 用户公开标识使用 `username`，题目沿用 `display_id`。
- 前端所有面向公开实体的 URL、展示、API 调用切换为公开标识（含 admin）；内部实体保持不变。
- 后端 API 同时接受公开标识与 UUID，旧链接不失效。
- 保持内部实体（私信会话/消息、自测、评论、澄清、题目小题等）继续使用 UUID，不纳入本次改造。

## 3. 非目标

- 不引入语义 slug 或中文转拼音。
- 不删除 UUID 主键，不改变数据库主键。
- 不要求用户/管理员可编辑 `public_id`。
- 不实现旧 URL 301 重定向（API 双解析已保证兼容）。
- 不改造私信会话、消息、评论、自测、题单内部关联、竞赛澄清等非公开 URL 实体的标识。

## 4. 关键决策

1. **存储载体**：直接在业务表新增 `public_id` 唯一列，而非统一映射表。理由：引用完整性天然成立、列表查询无需额外 JOIN、删除级联自然。
2. **生成规则**：创建时生成一次，不可变；格式为 `实体前缀 + 8 位随机字符`，字符集避免易混淆字符。
3. **用户标识**：直接使用 `username`（当前系统不允许改用户名，天然稳定）。
4. **题目标识**：继续使用现有 `display_id = type + number`，并补齐前端未使用它的位置。
5. **兼容策略**：后端 API 双解析（UUID / public_id / display_id / username）；前端只生成新标识。
6. **范围**：admin 页面同样切换。

## 5. 标识规则

| 实体 | 公开标识 | 示例 | 存储 |
|------|---------|------|------|
| 用户 | `username` | `zhangsan` | 已有 `users.username`（唯一） |
| 题目 | `display_id` | `P100` / `U42` | 已有，`type + number` 派生 |
| 竞赛 | `public_id` | `ct-8f3k2xq` | 新增 `contests.public_id` |
| 训练 | `public_id` | `tr-9qx2lm` | 新增 `trainings.public_id` |
| 提交 | `public_id` | `sub-3fk9xq` | 新增 `submissions.public_id` |
| 社区帖子 | `public_id` | `post-7m2nq8` | 新增 `community_posts.public_id` |
| 公告 | `public_id` | `ann-4d6k9m` | 新增 `announcements.public_id` |

短码生成规则：

- 前缀：`ct-` / `tr-` / `sub-` / `post-` / `ann-`
- 随机部分：8 位字符，取自 `123456789abcdefghjkmnpqrstuvwxyz`（避开 `0/o/1/i/l`）
- 创建时生成，不可变；唯一索引兜底，冲突时重新生成

## 6. 数据库迁移

### 6.1 Schema 变更

为以下表新增 `public_id text` 列 + 唯一索引：

- `contests.public_id`
- `trainings.public_id`
- `submissions.public_id`
- `community_posts.public_id`
- `announcements.public_id`

所有列在回填后设为 `NOT NULL`。

### 6.2 回填策略

1. 先以可空列迁移，生成唯一索引。
2. 用回填脚本对存量行生成 `public_id`（前缀 + 随机 8 位）。
3. 回填过程中捕获唯一冲突并重试。
4. 全部成功后执行 `ALTER COLUMN ... SET NOT NULL`。

> 回填脚本要求幂等：已存在 `public_id` 的行跳过。

## 7. 后端改造

### 7.1 新增 `src/lib/public-id.ts`

提供：

```ts
export function isUuid(value: string): boolean
export function isPublicId(entity: PublicEntity, value: string): boolean
export function generatePublicId(prefix: PublicPrefix): string
export async function resolvePublicId(
  entity: PublicEntity,
  value: string,
): Promise<string | null>  // 返回内部 UUID
```

解析语义：

- 若 `value` 是 UUID：按实体主键查找。
- 若 `value` 匹配该实体 `public_id` 格式：按 `public_id` 列查找。
- 题目沿用现有 `resolveProblem`（支持 UUID / display_id / 纯数字）。
- 用户按 `username` 或 UUID 查找。

### 7.2 路由改造

以下路由改为“先解析公开标识，再进入现有 handler”：

- `/api/v1/contests/:contestId`
- `/api/v1/trainings/:id`
- `/api/v1/submissions/:id`
- `/api/v1/community/posts/:postId`
- `/api/v1/announcements/:id`
- `/api/v1/users/:id`（username / UUID）
- `/api/v1/admin/...` 中涉及上述实体的路由

### 7.3 响应字段

- 竞赛 / 训练 / 提交 / 帖子 / 公告的响应类型增加 `public_id`。
- 用户响应已有 `username`；题目响应已有 `display_id`。
- 列表接口同样返回 `public_id`，供前端直接使用。

### 7.4 创建逻辑

在以下 service 的创建路径生成 `public_id` 并写入：

- `contests.ts`
- `trainings.ts`
- `submissions-crud.ts`
- `community-post-crud.ts`
- `announcements.ts`

## 8. 前端改造

### 8.1 URL 生成规则

| 场景 | 旧 | 新 |
|------|----|----|
| 用户页 | `/users/${user.id}` | `/users/${user.username}` |
| 题目页 | `/problems/${problem.id}` | `/problems/${problem.display_id \|\| problem.id}` |
| 竞赛页 | `/contests/${contest.id}` | `/contests/${contest.public_id}` |
| 训练页 | `/trainings/${training.id}` | `/trainings/${training.public_id}` |
| 提交页 | `/submissions/${submission.id}` | `/submissions/${submission.public_id}` |
| 帖子页 | `/community/posts/${post.id}` | `/community/posts/${post.public_id}` |
| 公告页 | `/announcements/${item.id}` | `/announcements/${item.public_id}` |
| 编辑器 | `/editor/${problem.id}` | `/editor/${problem.display_id}` |
| admin 题目编辑 | `/admin/problem-edit/${row.id}` | `/admin/problem-edit/${row.display_id}` |
| admin 竞赛/训练/提交/帖子等 | UUID | `public_id` |

### 8.2 API 路径

- `composables/useTrainings.ts`、`useContests.ts`、`useSubmissionPolling.ts` 等面向公开实体的 id 改为公开标识。
- `useObjective.ts` 的 `paperId` 改为 `display_id`；`questionId` 为内部实体，保持 UUID。
- `utils/problemTemplate.ts` 改为接收 `display_id`（兼容 UUID 传入）。
- `useSelfTestPolling`、`useMessages` 等内部实体保持 UUID，不修改。

### 8.3 展示层

- 提交列表/详情、队列、admin 提交列表：`id.slice(0, 8)` → `public_id`。
- 审计日志/LLM 用量：展示关联实体的 `public_id`/`display_id`（若响应提供；否则保留截断 UUID）。
- 社区发布题解：关联题目显示 `display_id` 而非 UUID。
- admin 删除确认等场景显示 `public_id` / `display_id`。

### 8.4 类型定义

- 所有 API 数据类型补充 `public_id` 字段。
- 前端新增/调整 URL 构造工具函数（如 `problemUrl(id)`、`userUrl(username)`），避免散落模板字符串。

## 9. 兼容性

- API 层：所有改造路由同时接受 UUID 与公开标识。
- 前端层：只生成公开标识；旧链接（书签/分享）因后端兼容仍可打开。
- 不新增 301/302 重定向。

## 10. 测试

### 后端

- `lib/public-id` 单元测试：UUID 识别、public_id 识别、解析命中/未命中。
- 各实体 route 测试：用 `public_id` 请求详情/更新/删除；用 UUID 请求仍成功。
- 创建测试：生成 `public_id` 非空、格式正确、唯一。
- 回填脚本幂等测试。

### 前端

- URL 工具函数单测。
- 关键页面/组件冒烟：提交列表、用户页、题目列表、竞赛、训练、帖子、公告、admin。
- 静态检查：不再出现面向公开实体的 `slice(0, 8)` UUID 展示。

## 11. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 回填唯一冲突 | 生成后捕获唯一索引冲突并重试 |
| 存量 UUID 链接失效 | API 双解析，前端无需重定向 |
| 列表接口多返回字段导致类型不一致 | 统一更新 noj-ui 类型定义，并跑 `deno task build` / `deno test` |
| admin 页面遗漏切换 | 以本设计文档第 8 节清单为验收标准，逐文件 grep UUID 用法 |

## 12. 验收清单

- [ ] 5 张业务表新增 `public_id` 唯一非空列，存量回填完成
- [ ] 后端创建逻辑生成 `public_id`
- [ ] 所有目标路由支持 UUID / 公开标识双解析
- [ ] 所有目标 API 响应包含 `public_id`
- [ ] 前端用户/题目/竞赛/训练/提交/帖子/公告 URL 全部切换
- [ ] admin 页面同步切换
- [ ] 公开实体的列表/详情不再展示 UUID 截断
- [ ] 后端单测、前端 lint/build 通过
