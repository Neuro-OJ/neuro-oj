# 用户头像上传设计

## Context

现状（issue #229）：
- `users` 表无头像字段（`noj-core/src/db/schema.ts:36-72`），用户设置仅 bio（`PUT /api/v1/users/me`）
- 全站无用户头像：`UserMenu` lucide 图标、`users/[id]` 与搜索首字母占位、社区纯用户名文本
- 上传先例 `POST /problems/import-bundle`（multipart + 扩展名/Content-Type/magic bytes/大小校验）；下载先例 `GET /problems/:id/support-package`（core 代理返回字节流，因 S3/MinIO 可能位于内网）
- `LocalStorageProvider` put/get/delete 硬编码 `.zip` 后缀，存图片需泛化扩展名
- Nitro 代理按 JSON 转发，图片字节流需二进制透传分支

完整设计见 `docs/superpowers/specs/2026-08-12-avatar-profile-design.md`。

## Goals / Non-Goals

**Goals:**
- `users.avatar_url` 字段（`noj-storage://` URL）+ 纯追加迁移
- 上传/替换/删除/公开展示四能力（校验：png/jpeg/webp、≤2MB、magic bytes；拒绝 SVG）
- 无头像默认展示：前端本地生成首字母 SVG 占位（用户名哈希稳定配色）
- 全站展示位统一接入 `UserIdentity` 组件（头像+用户名，参数控制显隐）
- E2E 覆盖上传/替换/删除、超限与非法类型被拒、默认头像

**Non-Goals:**
- 头像裁切/滤镜/多尺寸生成（CDN 级能力）
- 通用文件代理端点（YAGNI，头像为唯一用例）
- S3 presigned 直连（内网/跨域隐患，与支持包先例一致走 core 代理）
- SVG 上传支持（XSS 风险，明确拒绝）

## Decisions

1. **方案 A：专用头像端点 + 存储层复用**。DB 存 `noj-storage://` URL，`GET /:id/avatar` 查库读字节流返回；local/s3 行为统一。
2. **默认头像 = 前端 SVG 占位**：无头像 GET 404，组件渲染首字母 + 哈希配色占位。
3. **存储扩展名泛化**：contentType 推导扩展名（jpeg→jpg 规范化），旧无扩展名 key 回退 `.zip`。
4. **校验链**：扩展名 → Content-Type → ≤2MB → magic bytes；拒绝 SVG。
5. **替换清理顺序**：先 put → 更新 DB → delete 旧 URL（内容寻址同图不误删）。
6. **缓存**：`Cache-Control: public, max-age=86400` + ETag（checksum）；上传/删除后前端 `?t=` 破缓存。
7. **组件封装**：`UserIdentity`（user/showUsername/showAvatar/size/link/to），`<img>` @error 兜底。
