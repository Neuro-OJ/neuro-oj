## Why

登录后的可读 session Cookie 没有携带 `avatar_url`，导航栏只能把当前用户的头像状态当作未知并请求头像端点。对未设置头像的用户该端点按契约返回 404，导致导航栏出现加载失败图像，并且只有访问会刷新用户资料的页面后才恢复为默认头像。

## What Changes

- 在认证 session 的运行时解析和可读 Cookie 中传递当前用户的 `avatar_url`，明确区分有效头像地址、无头像 `null` 与旧 session 的未知状态。
- 导航栏收到明确的 `null` 时直接渲染首字母默认头像，不再请求必然 404 的头像端点。
- 保留旧版 session 缺少 `avatar_url` 时的兼容路径，并补充认证响应解析测试。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `user-avatar`: 登录用户的 session 状态必须携带头像状态，使无头像用户在导航栏稳定显示本地默认头像。

## Impact

- `noj-ui/server/utils/auth-session.ts`
- `noj-ui/server/api/[...slug].ts`
- `noj-ui/composables/useAuth.ts`
- `noj-ui/tests/authSession_test.ts`
- 不修改头像 API、数据库结构或头像存储逻辑。
