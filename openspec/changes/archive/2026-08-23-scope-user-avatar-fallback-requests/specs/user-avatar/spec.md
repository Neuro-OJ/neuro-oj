## MODIFIED Requirements

### Requirement: 头像统一展示组件

系统 SHALL 提供 `UserIdentity` 组件统一头像与用户名展示，全站复用。

- Props：`user`（必填，含 id/username/avatar_url）、`showUsername`（默认 true）、`showAvatar`（默认 true）、`size`（sm/md/lg，默认 md）、`link`（默认 true，点击跳转 `/users/:id`）、`to`（可选覆盖跳转目标）、`loadAvatarWhenUnknown`（默认 false）
- 有 `avatar_url` 时展示 `<img src="/api/v1/users/:id/avatar">`；无 `avatar_url` 或加载失败时展示默认 SVG 占位，且默认不得因无头像发起头像网络请求
- 当调用方显式启用 `loadAvatarWhenUnknown` 且 `avatar_url` 未提供（`undefined`）时，组件 SHALL 尝试加载头像端点；`avatar_url` 明确为 `null` 时仍直接展示默认 SVG 占位；加载失败时仍展示默认 SVG 占位
- 头像请求的 URL 在用户上传/删除头像后 MUST 能正确刷新（`?t=` 时间戳破缓存由使用方处理）
- 当展示用户 ID 或头像 URL 变化时，组件 SHALL 清除之前的加载失败状态并重新按当前用户判断头像展示方式

#### Scenario: 展示位接入组件
- **WHEN** 导航栏、用户主页、社区帖子/评论、私信、搜索、竞赛答疑等位置渲染用户信息
- **THEN** 统一使用 `UserIdentity` 组件，头像与用户名样式一致

#### Scenario: 已知无头像用户不发起请求
- **WHEN** `UserIdentity` 默认渲染 `avatar_url` 为 null 或未提供的用户
- **THEN** 直接显示首字母 SVG 占位图且不请求 `/api/v1/users/:id/avatar`

#### Scenario: 导航栏探测未知头像
- **WHEN** 导航栏渲染登录用户且 session 状态未提供 `avatar_url`，并显式启用 `loadAvatarWhenUnknown`
- **THEN** 组件尝试请求 `/api/v1/users/:id/avatar`；成功显示图片，失败显示首字母 SVG 占位图
