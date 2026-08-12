# 用户头像上传任务拆分

## 1. 数据层与存储层

- [ ] 1.1 `schema.ts` users 表加 `avatar_url: text("avatar_url")`（可空），`deno task db:generate` 生成迁移 0038
- [ ] 1.2 `LocalStorageProvider` 扩展名泛化（`EXT_BY_CONTENT_TYPE` 映射 + `filePathFor` 兼容旧 key），单测覆盖 png/jpg/webp/回退 .zip/旧 URL 兼容
- [ ] 1.3 `deno task test` 无回归

## 2. 后端 API

- [ ] 2.1 `services/users.ts`：`updateUserAvatar` / `clearUserAvatar` / `getUserAvatarBytes`（校验链：扩展名 → Content-Type → 2MB → magic bytes；替换先 put 后删旧）
- [ ] 2.2 `routes/users.ts`：`POST /me/avatar`（multipart）、`DELETE /me/avatar`（幂等 204）、`GET /:id/avatar`（公开，Content-Type + Cache-Control + ETag；无头像 404）；注册顺序在 `/:id/profile` 之前
- [ ] 2.3 路由测试 `tests/routes/avatar.test.ts`：上传成功/公开读取/超限/非法类型/伪造 magic bytes/替换清理/删除幂等/无头像 404

## 3. 全响应字段

- [ ] 3.1 `UserResponse` 与 `getUserProfile` / `getUserProfileAggregate` 加 `avatar_url`
- [ ] 3.2 community.ts 8 处 author 选择、messages 联系人、search 结果、contests 答疑 author、admin 用户列表补 `avatar_url`
- [ ] 3.3 既有路由测试追加 avatar_url 断言

## 4. 前端

- [ ] 4.1 `server/api/[...slug].ts` 图片二进制透传分支（content-type ∈ image/png|jpeg|webp → arrayBuffer + 透传头）
- [ ] 4.2 `components/shared/UserIdentity.vue`（props：user/showUsername/showAvatar/size/link/to；SVG 占位 + 哈希配色 + @error 兜底）
- [ ] 4.3 `useAuth.ts` UserResponse 加 `avatar_url`；`pages/settings.vue` 头像区块（预览/上传/删除/破缓存）
- [ ] 4.4 展示位接入：社区（FollowingFeed/CommentCard/community 各页/admin/community）→ 私信与搜索（ChatSidebar/messages/SearchResultItem/search）→ 导航与其余（UserMenu/users/[id]/ClarificationsPanel/ContestRanking/ranking/index/problems/[id]/contests/admin 用户与竞赛页）
- [ ] 4.5 `deno task lint` + `deno task build` 通过

## 5. E2E 与归档

- [ ] 5.1 `noj-tests/e2e/29_avatar.test.ts`：上传/替换/删除全流程、超限与非法类型被拒、无头像默认展示（GET 404）
- [ ] 5.2 全量验证通过后 `/opsx:archive` 归档 + `/opsx:sync` 同步主规范
