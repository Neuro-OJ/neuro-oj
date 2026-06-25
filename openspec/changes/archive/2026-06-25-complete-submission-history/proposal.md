## Why

Issue #36 要求实现提交历史页面，但目前只有管理后台的提交管理页（`/admin/submissions`），缺少用户自主查看提交历史的前端页面，且管理后台表格也未展示得分、耗时、内存等关键信息和评测结果状态标签。

## What Changes

- **新建** `pages/submissions/index.vue`：用户视角的提交历史列表页，支持分页浏览和筛选过往提交记录
- **改进** `pages/admin/submissions.vue`：补充得分、耗时、内存列，添加评测结果状态标签（AC=绿、WA=红、TLE=黄等）
- **统一状态标签组件**：将评测结果状态映射逻辑抽取为可复用组件/函数，供列表和详情页共享

## Capabilities

### New Capabilities
- `submission-history-page`: 用户提交历史列表页，支持分页和按题目、语言、状态筛选，展示提交 ID、题目、语言、状态（带颜色标签）、得分、用时、内存

### Modified Capabilities
- `submission-list-api`: `SubmissionListItem` 接口已包含 `result.status` 和 `result.score`，前端需展示这些字段

## Impact

- **noj-ui**: 新建 `pages/submissions/index.vue`，修改 `pages/admin/submissions.vue`，可能新增共享组件
- **无 API 变更**：后端 `/api/v1/submissions` 和 `/api/v1/admin/submissions` 已返回所有需要的数据
