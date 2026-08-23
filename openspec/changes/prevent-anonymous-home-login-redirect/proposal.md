## Why

匿名用户访问主页时，导航栏会请求仅登录用户可见的社区通知未读数。该请求收到 401 后被统一 API 层误判为当前页面必须登录，导致主页自动跳转到登录页，破坏公开访问入口。

## What Changes

- 让主页及全局布局中的后台状态探测请求在收到 401 时保持静默，不触发登录页跳转。
- 保留受保护页面和明确需要登录的业务请求的全局 401 跳转行为。
- 为匿名访问主页补充回归测试，覆盖通知未读数请求。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `ui-api-layer`: 增加后台/可选认证请求关闭 401 自动跳转的约定。

## Impact

- 修改 `noj-ui/composables/useCommunityNotifications.ts`，调用 API 时明确关闭 401 跳转。
- 可能补充 `useApi` 调用层测试或组件级静态回归测试。
- 不修改后端 API 的认证要求，也不改变通知数据权限。
