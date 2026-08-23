## ADDED Requirements

### Requirement: 认证 session 携带头像状态

登录或更新认证凭据后，系统 SHALL 在可读 session 状态中携带当前用户的 `avatar_url`：已设置头像时为对应地址，未设置头像时为 `null`。客户端从该 session 恢复用户信息后，导航栏 SHALL 将 `null` 视为已知无头像并直接展示本地默认头像，不得请求公开头像端点。

为兼容已存在的旧 session，缺少 `avatar_url` 的状态 MAY 被视为未知；客户端 MUST 在资料状态同步完成前展示本地默认头像，不得因此渲染一个已知会返回 404 的头像请求。资料同步失败时仍 MUST 保持本地默认头像。

#### Scenario: 登录无头像用户

- **WHEN** 用户登录成功且用户没有自定义头像
- **THEN** 可读 session 包含 `avatar_url: null`，导航栏显示首字母默认头像且不请求 `/api/v1/users/:id/avatar`

#### Scenario: 登录有头像用户

- **WHEN** 用户登录成功且用户已设置自定义头像
- **THEN** 可读 session 包含非空 `avatar_url`，导航栏请求并显示该用户头像

#### Scenario: 旧 session 缺少头像字段

- **WHEN** 客户端从不含 `avatar_url` 的旧 session 恢复登录用户
- **THEN** 导航栏先显示首字母默认头像并同步当前用户资料；同步得到头像地址后显示头像，得到 null 或同步失败时保持默认头像
