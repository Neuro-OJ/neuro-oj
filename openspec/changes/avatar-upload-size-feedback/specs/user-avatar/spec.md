## MODIFIED Requirements

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
- 上传因文件超过 2MB 或其他可识别的校验错误失败时，设置页 MUST 向用户展示对应的错误通知；失败不得显示“头像已更新”成功通知

#### Scenario: 上传 png 头像成功
- **WHEN** 已登录用户 POST `/api/v1/users/me/avatar`，multipart 携带合法 `file`（png，≤2MB）
- **THEN** 返回 200，`avatar_url` 为 `noj-storage://` 前缀 URL，`users.avatar_url` 已更新，设置页展示“头像已更新”成功通知

#### Scenario: 选择超限文件时即时提示
- **WHEN** 用户在设置页选择大小超过 2MB 的头像文件
- **THEN** 设置页阻止上传，展示“头像大小超过限制（最大 2MB）”错误通知，并清空文件选择

#### Scenario: 服务端拒绝超限文件时提示
- **WHEN** 设置页发起头像上传且服务端返回文件超过 2MB 的错误
- **THEN** 设置页展示后端返回的大小限制错误通知，不展示成功通知

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
