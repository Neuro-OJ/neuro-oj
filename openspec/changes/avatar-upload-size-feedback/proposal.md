## Why

用户上传超过 2MB 的头像时，上传请求可能在前端预校验之后仍被后端或代理拒绝，当前设置页没有对该失败路径做明确处理。补充统一的失败通知，让用户知道头像未上传成功以及具体原因。

## What Changes

- 设置页头像上传使用显式错误处理，在上传接口返回大小限制错误或其他失败时显示通知。
- 保留选择文件阶段的 2MB 前端预校验，并为头像上传增加回归覆盖。

## Capabilities

### New Capabilities

<!-- No new capability is introduced. -->

### Modified Capabilities

- `user-avatar`: 头像上传失败时必须向用户展示可理解的错误通知。

## Impact

- `noj-ui/pages/settings.vue`：头像上传错误处理与通知。
- `noj-ui/tests/`：头像上传错误文案/校验回归测试。
- 不修改后端接口、数据库或头像大小限制（仍为 2MB）。
