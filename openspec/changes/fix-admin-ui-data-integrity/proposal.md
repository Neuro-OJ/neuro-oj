## Why

管理后台在真实数据加载和变更操作中存在角色误覆盖、请求乱序覆盖、重复重测以及变更后列表不同步等问题。宽表在窄屏下也无法可靠完成管理操作，降低了后台在移动场景和故障场景下的可用性。

## What Changes

- 为用户角色编辑加载并预选当前角色，避免保存时意外覆盖已有权限。
- 为后台列表请求增加过期响应保护，并在变更后可靠同步本地状态。
- 禁止对已有活跃评测任务的提交重复重测，并展示批量重测的实际入队与跳过数量。
- 修复评测镜像删除后的列表同步，避免过期行继续可操作。
- 让系统设置的并发保存不会覆盖其他未保存草稿。
- 为后台宽表提供窄屏横向访问能力，并补齐通用弹窗的键盘与辅助技术语义。
- 改进仪表盘的部分失败提示、后台导航分组及竞赛题目选择的按需搜索能力。

## Capabilities

### New Capabilities

- `admin-ui-interaction-resilience`: 后台列表、弹窗和数据变更操作在并发、失败和窄屏场景下保持可靠可用。

### Modified Capabilities

- `admin-role-management`: 用户角色编辑器必须预选当前角色，防止非预期角色覆盖。
- `admin-submission-rejudge`: 单条重测必须拒绝已有活跃评测任务的提交。
- `admin-problem-management`: 批量重测反馈实际入队与跳过数量。
- `admin-submission-management`: 重测操作必须在任务提交期间防止重复触发。
- `admin-system-settings`: 多项设置的草稿在并发保存时不得丢失。
- `admin-dashboard`: 仪表盘必须显示部分统计加载失败及刷新状态。
- `judge-image-whitelist`: 删除镜像后管理列表必须立即反映已删除状态。

## Impact

- 前端：`noj-ui/pages/admin/`、`noj-ui/components/admin/`、`noj-ui/composables/useAdminList.ts` 与竞赛题目选择流程。
- 后端：`noj-core/src/services/submissions-rejudge.ts` 的单条重测状态保护。
- 测试：补充前端组合函数和后端服务层的并发、活跃任务与状态同步覆盖。
