## ADDED Requirements

### Requirement: 用户上传头像

系统 SHALL 提供头像上传端点 `POST /api/v1/users/me/avatar`，供已登录用户上传或替换自己的头像。

- 仅本人可调用（authMiddleware）；未登录用户 MUST 收到 401
- 请求为 multipart/form-data，字段名 `file`；缺失或非文件 MUST 收到 400
- 文件校验链（任一项不满足 MUST 收到 400）：
  - 扩展名 ∈ {png, jpg, jpeg, webp}
  - Content-Type ∈ {image/png, image/jpeg, image/webp}
  - 大小 ≤ 2MB
  - magic bytes 匹配（PNG `89 50 4E 47` / JPEG `FF D8 FF` / WEBP `RIFF..WEBP`）
- SVG（image/svg+xml）MUST 被拒绝（内嵌脚本 XSS 风险）
- 成功后将文件存入存储层（`noj-storage://` URL），写入 `users.avatar_url`，返回 200 与 `{ "avatar_url": "<noj-storage://...>" }`
- 替换语义：先存新文件再清理旧文件；同图重复上传（URL 相同）MUST 不误删旧文件
- 替换后用户信息响应（`/auth/me` 等）中的 `avatar_url` MUST 立即反映新值

#### Scenario: 上传 png 头像成功
- **WHEN** 已登录用户 POST `/api/v1/users/me/avatar`，multipart 携带合法 `file`（png，≤2MB）
- **THEN** 返回 200，`avatar_url` 为 `noj-storage://` 前缀 URL，`users.avatar_url` 已更新

#### Scenario: 上传超限文件被拒
- **WHEN** 已登录用户 POST 头像，文件大小超过 2MB
- **THEN** 返回 400，`avatar_url` 不变

#### Scenario: 非法类型被拒
- **WHEN** 已登录用户 POST 头像，文件为 txt、svg 或扩展名/Content-Type 不匹配
- **THEN** 返回 400，`avatar_url` 不变

#### Scenario: 伪造扩展名的非图片被拒
- **WHEN** 已登录用户 POST 头像，文件名为 `.png` 但内容非图片（magic bytes 不符）
- **THEN** 返回 400

#### Scenario: 未登录上传被拒
- **WHEN** 未登录用户 POST `/api/v1/users/me/avatar`
- **THEN** 返回 401

### Requirement: 用户删除头像

系统 SHALL 提供头像删除端点 `DELETE /api/v1/users/me/avatar`，供已登录用户删除自己的头像。

- 仅本人可调用；未登录用户 MUST 收到 401
- 删除 `users.avatar_url` 并清理存储文件；幂等——无头像时删除 MUST 仍返回 204
- 删除后公开展示端点 MUST 返回 404

#### Scenario: 删除头像成功
- **WHEN** 已登录且已设置头像的用户 DELETE `/api/v1/users/me/avatar`
- **THEN** 返回 204，`users.avatar_url` 为 NULL

#### Scenario: 无头像时删除幂等
- **WHEN** 已登录且未设置头像的用户 DELETE `/api/v1/users/me/avatar`
- **THEN** 返回 204，无错误

### Requirement: 公开展示头像

系统 SHALL 提供公开头像端点 `GET /api/v1/users/:id/avatar`，无需认证。

- 用户已设置头像：返回图片字节流，Content-Type 按扩展名推断（png/jpeg/webp），`Cache-Control: public, max-age=86400`，`ETag` 为内容校验和
- 用户未设置头像或不存在：MUST 返回 404（默认头像由前端组件渲染，后端不参与生成）

#### Scenario: 读取已设置头像
- **WHEN** GET `/api/v1/users/<已设置头像的用户id>/avatar`
- **THEN** 返回 200，Content-Type 正确，缓存头为 `public, max-age=86400`

#### Scenario: 读取无头像用户返回 404
- **WHEN** GET `/api/v1/users/<未设置头像的用户id>/avatar`
- **THEN** 返回 404

### Requirement: 默认头像展示

系统 SHALL 在用户未设置头像时展示默认头像。

- 默认头像为前端本地生成的首字母 SVG 占位图：取用户名首个字符大写，背景色按用户名哈希稳定生成（同一用户全站一致）
- 头像加载失败（文件损坏/丢失）时 MUST 兜底回退到默认占位，不破版

#### Scenario: 无头像用户显示首字母占位
- **WHEN** 前端渲染未设置头像用户的头像位
- **THEN** 显示该用户名首字母的 SVG 占位图，配色稳定

#### Scenario: 图片加载失败兜底
- **WHEN** `<img>` 加载已设置头像失败（如存储文件被删）
- **THEN** 组件回退显示首字母 SVG 占位

### Requirement: 头像统一展示组件

系统 SHALL 提供 `UserIdentity` 组件统一头像与用户名展示，全站复用。

- Props：`user`（必填，含 id/username/avatar_url）、`showUsername`（默认 true）、`showAvatar`（默认 true）、`size`（sm/md/lg，默认 md）、`link`（默认 true，点击跳转 `/users/:id`）、`to`（可选覆盖跳转目标）
- 有 `avatar_url` 时展示 `<img src="/api/v1/users/:id/avatar">`；无 `avatar_url` 或加载失败时展示默认 SVG 占位
- 头像请求的 URL 在用户上传/删除头像后 MUST 能正确刷新（`?t=` 时间戳破缓存由使用方处理）

#### Scenario: 展示位接入组件
- **WHEN** 导航栏、用户主页、社区帖子/评论、私信、搜索、竞赛答疑等位置渲染用户信息
- **THEN** 统一使用 `UserIdentity` 组件，头像与用户名样式一致
