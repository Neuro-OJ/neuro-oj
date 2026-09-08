# Agent Note: 管理端写操作接入乐观锁 If-Match

Status: implemented

## Problem

后端已为 admin 可编辑资源接入 `adminVersionMiddleware` 乐观锁，但前端管理页面的写操作尚未统一携带 `If-Match` 头。多个管理员同时编辑同一资源时，后提交者可能静默覆盖先提交者的修改，无法触发 `409 VERSION_CONFLICT` 冲突提示。

## Decision

- 在管理端所有已接入后端乐观锁的写操作中，统一从列表/详情响应读取 `updated_at`，并以 `If-Match: "<updated_at>"` 头随请求发送。
- 覆盖范围：题单（`TrainingManagementSection.vue`）、角色（`roles.vue`）、LLM Provider（`llm/providers.vue`）、社区板块（`CommunityBoardsSection.vue`）、社区设置逐项保存（`community.vue`）、举报处理/驳回/撤销（`community.vue`、`reports.vue`）、社区处罚撤销（`community.vue`）、用户解封（`users.vue`）。
- 后端 `listUsers` 的 `active_ban` 增加 `updated_at` 字段，供解封操作携带活跃封禁记录的乐观锁版本。
- `useCommunity.ReportRow` 修正为与后端 `listReports` 实际返回一致的嵌套结构，并补充 `report.updated_at`。
- 未接入后端乐观锁的写操作（如用户改角色/封禁/注销、标签、题目、内容审核等）不强行添加 `If-Match`，保持与后端能力一致。

## Alternatives considered

- 在前端统一封装 `useAdminForm` 自动附加版本头：当前多数页面仍使用各自表单状态，统一封装需要大规模重构，收益有限；因此采用逐页在调用点附加 `If-Match` 的最小改动。
- 为社区设置保存额外请求 `/api/v1/admin/system/settings` 获取每个 key 的 `updated_at`：相比不携带版本头，能真正触发后端冲突检测；相比修改社区配置接口返回版本，改动面更小。

## Consequences

- 管理端写操作在资源被其他管理员修改后会收到 `409 VERSION_CONFLICT`，由 `useApi` 统一弹出后端错误信息。
- 前端类型与后端响应保持一致，`community.vue` 的举报展示/处理逻辑不再依赖错误的扁平结构。
- 用户列表 `active_ban` 新增 `updated_at` 字段，属于向后兼容的增量字段，不影响现有消费方。
