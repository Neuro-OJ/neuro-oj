## Why

管理员在后台保存竞赛时，竞赛可能已经写入数据库，但页面却提示网络连接失败，导致用户重复点击并创建多个相同竞赛。创建操作需要在当前页面可靠地完成反馈和列表更新，避免整页重载与并发请求造成的误判。

## What Changes

- 创建或编辑竞赛成功后，在当前管理页面立即显示成功反馈并刷新竞赛列表。
- 保存期间保持提交按钮禁用，避免同一表单触发重复创建。
- 刷新请求失败时保留已有竞赛数据并显示可理解的错误，不把成功的创建误报为网络失败。
- 不改变竞赛管理 API 的状态码、数据模型或权限规则。

## Capabilities

### New Capabilities

<!-- 无新增能力；本变更修改现有竞赛管理能力的管理端交互契约。 -->

### Modified Capabilities

- `contest-management`: 补充管理端创建/编辑竞赛成功后的即时反馈、列表刷新和重复提交防护要求。

## Impact

- `noj-ui/pages/admin/contests.vue`：调整竞赛保存后的刷新与反馈流程。
- `noj-ui/components/admin/ContestFormModal.vue`：确保保存期间提交控件保持禁用并提供明确状态。
- `noj-ui` 前端测试：覆盖成功保存刷新、失败保留数据和重复提交防护。
- noj-core API 无需改动；现有 `POST /api/v1/admin/contests` 的 201 响应继续作为成功契约。
