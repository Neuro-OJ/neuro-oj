# 用户头像上传（avatar-profile）变更提案

## Why

`users` 表无头像字段，全站无任何用户头像展示（`UserMenu` 用 lucide 图标、用户主页与搜索用首字母 div 占位、社区帖子/评论只显示用户名）。对标 HydroOJ，头像是社区 OJ 用户识别标配（issue #229）。

## What Changes

- 数据：`users` 表新增 `avatar_url`（text 可空），存 `noj-storage://` URL，Drizzle 迁移
- 上传端点：复用存储层（local/s3）与上传校验链（扩展名 → Content-Type → ≤2MB → magic bytes），仅允许 png/jpeg/webp，**拒绝 SVG**（XSS）
- API：`POST /api/v1/users/me/avatar`（上传/替换）、`DELETE /api/v1/users/me/avatar`（删除，幂等）、`GET /api/v1/users/:id/avatar`（公开展示，字节流 + `Cache-Control: public, max-age=86400` + ETag）
- 展示：无头像时由前端 `UserIdentity` 组件渲染本地生成的首字母 SVG 占位（按用户名哈希稳定配色，零外部依赖）
- UI：设置页头像上传/替换/删除区块；全站展示位（导航栏、用户主页、社区、私信、搜索、竞赛答疑、admin）统一接入 `UserIdentity` 组件
- 代理：Nitro 代理（`server/api/[...slug].ts`）增加图片二进制透传分支
- 存储层：`LocalStorageProvider` 扩展名泛化（`image/png→png`、`image/jpeg→jpg`、`image/webp→webp`，未知回退 `.zip`，向后兼容旧 URL）

## Capabilities

### New Capabilities

- `user-avatar`: 用户头像完整能力——上传/替换/删除 API、校验约束（类型/大小/magic bytes）、公开展示端点与缓存、默认 SVG 占位语义

### Modified Capabilities

- `user-profile`: `GET /api/v1/users/:id/profile` 的 `user` 对象新增 `avatar_url` 字段
- `database-schema`: `users` 表新增 `avatar_url` 列

## Impact

- **noj-core**：`src/db/schema.ts`（avatar_url 列）+ 新迁移；`src/lib/storage/local.ts`（扩展名泛化）；`src/services/users.ts`（头像 service）；`src/routes/users.ts`（3 个端点）；`src/types/auth.ts`（UserResponse）；community/messages/search/contests 响应的用户对象补 `avatar_url`
- **noj-ui**：`components/shared/UserIdentity.vue`（新）；`pages/settings.vue`（头像区块）；`composables/useAuth.ts`（类型）；`server/api/[...slug].ts`（二进制透传）；全站展示位文件
- **noj-tests**：新增 `e2e/29_avatar.test.ts`
- **数据库**：纯追加迁移（`users` 加可空列），无破坏性变更
- **无评测引擎改动**；无新依赖
