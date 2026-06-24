## Why

用户提交代码后，无法得知评测进度——无法区分代码是在排队等待评测、正在评测中、还是已经完成。这导致用户体验不佳，尤其在队列积压时用户完全无法感知系统状态。需要让评测队列的完整状态对用户透明。

## What Changes

- **`GET /api/v1/queue`** — 新增公共 API，返回当前评测队列的完整状态（pending/judging/recently_completed 三区列表及统计），无需认证
- **`GET /api/v1/submissions/:id/status`** — 新增认证 API，返回单个提交的排队位置、评测状态、开始/完成时间
- **增强 `GET /api/v1/submissions/:id`** — 在现有响应中增加 `status`、`queue_position`、`queue_length`、`judge_started_at`、`judge_finished_at` 字段
- **新增前端 `/queue` 页面** — 独立的全局队列浏览页面，三区域分组展示
- **增强提交结果页 `submissions/[id].vue`** — 增加排队/评测中的过渡状态展示和轮询

## Capabilities

### New Capabilities
- `queue-overview`: 全局评测队列概览。提供 `GET /api/v1/queue` 公共 API（无须认证）和前端 `/queue` 页面，展示 pending/judging/recently_completed 三区列表及统计数据。
- `submission-status-tracking`: 单个提交的队列状态追踪。提供 `GET /api/v1/submissions/:id/status` 认证 API，返回排队位置、当前状态、时间戳，并增强现有 `/submissions/:id` 响应字段。

### Modified Capabilities
- `submission-list-api`: 增强 `GET /api/v1/submissions/:id` 响应，增加评测状态相关字段（status, queue_position, queue_length 等）

## Impact

| 模块 | 影响 |
|------|------|
| **noj-core** | 新增两个 API 端点 + 修改一个现有端点；需通过 BullMQ 查询队列状态并关联 submission 元数据 |
| **noj-ui** | 新增 `/queue` 页面；修改 `submissions/[id].vue` 增加过渡状态展示和轮询逻辑 |
| **Redis / BullMQ** | 依赖现有队列基础设施的 `getWaiting()`、`getActive()`、`getCompleted()` 等方法 |
| **权限模型** | guest 可无认证访问全局队列概览；任意已登录 user 可查任意 submission 的排队状态（非本人也可查） |
