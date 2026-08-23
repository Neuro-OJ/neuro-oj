## Context

`GET /api/v1/users/:id/avatar` 对无头像用户返回 404，并在读取前执行数据库查询。`UserIdentity` 的多数调用方已经获得了 `avatar_url`，只有导航栏从可读 session cookie 恢复用户状态时可能不知道头像是否存在。

## Goals / Non-Goals

**Goals:**

- 保持列表、社区和资料页对已知无头像用户的零头像请求行为。
- 让导航栏继续处理 session cookie 缺少头像状态的场景。
- 在用户切换或头像状态变化后清除旧的加载失败状态。

**Non-Goals:**

- 不修改头像 API、缓存策略、数据库 schema 或 session cookie 格式。
- 不改变默认 SVG 占位图的外观或头像上传流程。

## Decisions

- **显式组件开关**：新增默认关闭的 `loadAvatarWhenUnknown` prop，并只在 `UserMenu` 传入 `true`。这样保留通用组件对 `avatar_url` 的既有契约，同时将 PR288 的特殊需求限制在导航栏。相比让所有调用方始终探测，能够避免列表页面的 404 请求放大。
- **按 ID 与 URL 重置失败状态**：用一个 getter 同时观察 `user.id` 和 `user.avatar_url`。相比只观察 URL，这能覆盖同一组件实例切换到另一个用户但 URL 仍为空的情况。
- **保持现有错误回退**：仍使用图片 `error` 事件切换到本地 SVG，占位逻辑不需要额外请求或状态管理。

## Risks / Trade-offs

- [Risk] 导航栏在无头像用户上仍会产生一次 404 → 这是 session 缺少头像状态的必要兼容行为，且只影响单个登录用户的导航栏。
- [Risk] 头像上传后的浏览器缓存刷新仍由调用方通过查询参数负责 → 本变更不扩大已有缓存策略范围。
