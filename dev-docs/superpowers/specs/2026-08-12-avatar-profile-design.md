# 用户头像上传设计

> 关联 issue：[#229 feat: 支持用户头像上传](https://github.com/Neuro-OJ/neuro-oj/issues/229)
> 日期：2026-08-12
> 状态：已批准（brainstorming 流程）

## 背景与目标

- 现状：`users` 表无头像字段（`noj-core/src/db/schema.ts:36-72`），用户设置仅 bio（`noj-core/src/routes/users.ts` PUT `/me`）。
- 全站**没有任何用户头像展示**：`UserMenu` 用 lucide 图标、`users/[id]` 与搜索用首字母 div 占位、社区帖子/评论只显示用户名。
- 对标 HydroOJ：头像系统是社区 OJ 用户识别标配。

**目标**：

1. `users` 表新增 `avatar_url`（Drizzle 迁移），复用现有存储层（local/s3，`noj-storage://` 先例）；
2. 上传/替换/删除端点 + 公开展示端点，校验类型（png/jpeg/webp）与大小（≤2MB），**拒绝 SVG**（内嵌脚本 XSS 风险）；
3. 无头像用户展示**本地生成首字母 SVG 占位图**（按用户名哈希稳定配色，零外部依赖）；
4. 全站展示位统一接入，头像 + 用户名封装为 `UserIdentity` 组件（参数控制单独展示头像/用户名，默认两者展示）。

## 现状分析（代码位置）

| 位置 | 现状 |
|------|------|
| `noj-core/src/db/schema.ts:36-72` | `users` 表无头像字段；`bio` 等字段先例 |
| `noj-core/src/routes/users.ts` | `PUT /api/v1/users/me` 仅 bio；`/search`、`/:id/profile` |
| `noj-core/src/routes/problems.ts:269-340` | 上传先例 `POST /problems/import-bundle`：multipart + 扩展名/Content-Type/**magic bytes**/大小校验链 |
| `noj-core/src/routes/problems.ts:341-368` | 下载先例 `GET /problems/:id/support-package`：core 代理返回字节流（注释明确"S3/MinIO 可能位于内网"，故统一走代理） |
| `noj-core/src/lib/storage/local.ts` | `put/get/delete` **硬编码 `.zip` 后缀**，无法直接存图片，需泛化扩展名（向后兼容旧 URL） |
| `noj-core/src/lib/storage/s3.ts` | 以 key 存储 + 显式 ContentType，无需改动 |
| `noj-core/src/lib/storage/types.ts` | `StorageProvider` 接口、`noj-storage://` URL 格式（`local/<key>?checksum_sha256=` / `s3/<key>?checksum_sha256=`） |
| `noj-ui/server/api/[...slug].ts` | Nitro 代理 `$fetch.raw` 后 `return data`（按 JSON 处理），图片字节流需二进制透传分支 |
| `noj-ui/components/layout/UserMenu.vue` | lucide-user 图标 + 用户名文本 |
| `noj-ui/pages/users/[id].vue:182` | `username.charAt(0).toUpperCase()` 首字母占位 |
| `noj-ui/pages/settings.vue` | 仅 bio 编辑，无头像区块 |
| 社区/私信/搜索/竞赛答疑/admin | 纯用户名文本或首字母占位（FollowingFeed、CommentCard、ChatSidebar、SearchResultItem、ClarificationsPanel 等） |
| `openspec/specs/` | 无头像相关规范，需新建变更提案 |

## 已确认的设计决策

1. **方案 A：专用头像端点 + 存储层复用**。`avatar_url` 存 `noj-storage://` URL（与支持包一致，local/s3 可无缝切换）；公开展示端点查库 → 存储层 `get()` → 字节流 + 缓存头。不做通用文件代理（YAGNI）、不做 S3 presigned 直连（内网/跨域隐患，与支持包先例刻意绕开的坑相同）。
2. **默认头像 = 本地生成首字母 SVG**：无头像时 GET 端点返回 404，由前端 `UserIdentity` 组件渲染首字母 + 稳定配色占位（不发多余请求、任意尺寸清晰、零外部依赖）。
3. **存储层扩展名泛化**：`put(key, data, contentType)` 从 contentType 推导扩展名（`image/png→png`、`image/jpeg→jpg`、`image/webp→webp`，未知回退 `.zip`）；`get/delete` 解析 key 末段扩展名，未知回退 `.zip`（向后兼容既有无扩展名支持包 URL）。
4. **上传校验链**：扩展名 ∈ {png, jpg, jpeg, webp} → Content-Type ∈ 三种图片类型 → ≤2MB → magic bytes（PNG `89 50 4E 47` / JPEG `FF D8 FF` / WEBP `RIFF..WEBP`）。拒绝 SVG。
5. **替换时旧文件清理顺序**：先 put 新文件 → 更新 DB → 再 delete 旧 URL（内容寻址下同图 URL 相同，不会误删仍在使用的文件）。
6. **缓存策略**：GET 端点 `Cache-Control: public, max-age=86400` + `ETag`（内容 checksum）；上传/删除成功后前端用 `?t=${Date.now()}` 破本地缓存；其他用户最迟 1 天自然更新。
7. **前端组件封装**：`UserIdentity` 组件统一头像 + 用户名展示，`showAvatar` / `showUsername` 参数控制显隐，默认两者展示；`<img>` `@error` 兜底切回占位。

## 详细设计

### 1. 数据层

- `users` 表新增 `avatar_url: text`（可空，默认 NULL），值形如 `noj-storage://local/<hash>.png?checksum_sha256=<hex>` 或 `noj-storage://s3/<key>?checksum_sha256=<hex>`。
- Drizzle 迁移 0038（`deno task db:generate` 生成）。

### 2. 存储层改造（`lib/storage/local.ts`）

- `put`：contentType → 扩展名映射表（`image/png→png`、`image/jpeg→jpg`、`image/webp→webp`，**jpeg 统一规范化为 jpg**，未知回退 `.zip`）；文件名 `<base64url-hash>.<ext>`；URL key 同步带扩展名。
- `get(url)` / `delete(url)`：从 key 末段解析扩展名，未知回退 `.zip`——**向后兼容**既有 `support_package_storage_url` 旧 URL。
- S3 模式无需改动。

### 3. API 端点（`routes/users.ts`）

| 端点 | 方法 | 鉴权 | 说明 |
|------|------|------|------|
| `/api/v1/users/me/avatar` | POST | 登录 | multipart `file`；校验链见决策 4；成功 → 存储 → 更新 DB → 清理旧文件 → 返回 `{ avatar_url }` |
| `/api/v1/users/me/avatar` | DELETE | 登录 | 清空字段 + 删除文件；幂等（无头像也返回 204） |
| `/api/v1/users/:id/avatar` | GET | 公开 | 无头像 → 404；有 → 存储层 `get()` → 按扩展名推断 Content-Type → `Cache-Control: public, max-age=86400` + `ETag: checksum` |

- `/me/avatar` 注册顺序在 `/:id/profile` 之前（与现有 `/me` 同款注释约定，避免 "me" 被匹配为 `:id`）。
- 错误复用 `AppError` 继承体系（`BadRequestError` 等）。
- 所有返回用户信息的响应加 `avatar_url` 字段：`UserResponse`（登录、`/auth/me`）、`users/:id/profile`、社区 posts/comments 的 `author`、用户/社区搜索、私信会话联系人。

### 4. Nitro 代理二进制透传（`server/api/[...slug].ts`）

- 转发时检查后端响应头 `content-type`：
  - `application/json` → 现状分支（登录拦截、Cookie 设置、`cache-control: no-store` 逻辑不变）；
  - 图片类型（`image/png` / `image/jpeg` / `image/webp`，即头像端点可能的三种）→ `$fetch.raw(..., { responseType: 'arrayBuffer' })`，透传 `Content-Type` / `ETag` / `Cache-Control`，`return new Response(buffer, { headers })` 原样返回字节流。
- `shouldInterceptAuth` 等现有逻辑只针对 JSON 分支，二进制分支不涉及。

### 5. 前端 `UserIdentity` 组件（`components/shared/UserIdentity.vue`）

```
Props:
  user          { id, username, avatar_url? }  必填
  showUsername  boolean   默认 true
  showAvatar    boolean   默认 true
  size          'sm'|'md'|'lg'   默认 md
  link          boolean   默认 true（点击跳转 /users/:id，可用 to 覆盖）
```

渲染逻辑：

- `user.avatar_url` 非空 → `<img :src="/api/v1/users/${id}/avatar">`；`@error` 兜底切到占位；
- 无头像 → 内联 SVG 占位：首字母 + 按 `username` 哈希取 HSL 稳定背景色，圆形，尺寸随 size 档位；
- 头像与用户名 gap、hover 样式组件内统一。

### 6. 展示位接入清单

| 位置 | 现状 | 接入方式 |
|------|------|---------|
| `components/layout/UserMenu.vue` | lucide-user 图标 + 用户名 | 头像(sm) + 用户名 |
| `pages/users/[id].vue` | `charAt(0)` 首字母 div | 头像(lg) + 用户名 |
| 社区：FollowingFeed / CommentCard / posts/[postId] / bookmarks / notifications / admin/community | 纯用户名文本 | `UserIdentity` |
| 私信：ChatSidebar / messages 页 | 首字母圆形 | `UserIdentity` |
| 搜索：SearchResultItem | 首字母 + 文本 | `UserIdentity` |
| 竞赛答疑 ClarificationsPanel / admin/users / ContestRanking | 纯用户名 | `UserIdentity` |

### 7. 设置页 `pages/settings.vue` 新增头像区块

- 当前头像预览（lg）+「上传头像」按钮（`<input type="file" accept="image/png,image/jpeg,image/webp">`）；
- 前端预校验类型/大小（与后端阈值一致），`FormData` 走 `useApi`（`SupportPackageUpload.vue` 先例）；
- 已有头像时显示「删除头像」按钮（`DELETE /me/avatar`，弹确认框）；
- 上传成功 → 更新本地 `useAuth` user 状态 + 预览带时间戳参数破缓存。

### 8. 边界与错误处理

| 场景 | 处理 |
|------|------|
| 替换时旧文件清理 | 先 put → 更新 DB → 再 delete 旧 URL；同图重复上传 URL 相同不误删 |
| 无头像 GET | 404（前端组件因此渲染 SVG 占位） |
| 图片加载失败 | `<img>` `@error` 兜底 → 切回首字母 SVG 占位 |
| 越权写操作 | authMiddleware 保证仅本人（与 `/me` 一致） |
| 上传并发 | 后写覆盖先写；旧文件按最终 URL 比对清理 |
| 存储异常（磁盘满/权限） | 存储层异常 → `BadRequestError`/500，前端 toast 展示 |
| 伪造扩展名非图片 | magic bytes 校验兜底拒绝（与 zip 先例同构） |

## 测试计划

**noj-core**

- `tests/lib/storage/`：LocalStorageProvider 扩展名推导（png/jpg/webp/未知回退 .zip）、get/delete 兼容带扩展名 key、向后兼容旧无扩展名 URL；
- `tests/routes/`（avatar）：上传成功（三种格式各一）；超限（>2MB）拒绝；非法类型（txt、svg）拒绝；magic bytes 伪造拒绝；替换后旧文件删除（local 模式断言存储目录）、同图重复上传不误删；删除幂等 + 删除后 GET 404；无头像 GET 404；他人 token 调 `/me/avatar` 403/401；各响应（auth/me、profile、community author、搜索）含 `avatar_url`；
- 迁移测试：0038 迁移可应用。

**noj-ui**

- `deno lint` / `deno fmt` / `nuxt build` 通过；页面冒烟验证（项目无组件测试先例，不新增）。

**noj-tests E2E（对应 issue 验收标准）**

- 上传/替换/删除头像全流程；
- 超限文件与非法类型被拒（断言 400 与错误信息）；
- 无头像用户展示默认头像（断言 GET 404 + 前端占位）；
- 头像经 Nitro 代理加载字节一致。

## 验收对照（issue #229）

| 验收标准 | 覆盖 |
|---------|------|
| E2E：上传/替换/删除头像；超限与非法类型被拒 | noj-tests 新用例 + core 路由测试 |
| 无头像用户展示默认头像 | GET 404 + UserIdentity SVG 占位（首字母 + 稳定配色） |

## OpenSpec

新建变更提案 `openspec/changes/avatar-profile/`（含 delta specs：database-schema / user-profile），实现完成后走 `/opsx:archive` 归档、`/opsx:sync` 同步主规范。
