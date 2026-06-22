## Context

用户主页目前只返回 `id`、`username`、`created_at` 三个字段，缺少用户自我表达的空间。Phase 1 的用户主页功能已基本完成，现在是低成本、高 ROI 的增量补充。

当前状态：

- `users` 表：无 bio 字段
- `GET /api/v1/users/:id/profile`：返回 `user` 对象只含 id、username、created_at
- 无用户资料更新端点（仅有 `GET /api/v1/auth/me` 用于查看自己的基本信息）

## Goals / Non-Goals

**Goals：**

- 用户可在个人主页展示一段 Markdown 格式的自我介绍
- 用户可自由编辑自己的 bio
- 后端渲染时原样输出 Markdown 文本，前端负责渲染展示

**Non-Goals：**

- 不添加 URL 链接、短签名等额外字段
- 不做审核流程（bio 是纯展示内容，无敏感信息审核需求）
- 不做富文本编辑器（使用纯文本 + Markdown 渲染）
- 不涉及社交功能（关注、点赞、评论等）

## Decisions

### Decision 1：bio 默认值使用空字符串而非 NULL

**选择：** `DEFAULT ''`

**理由：**

- 前端条件判断统一：`if (bio)` 即可，无需同时检查 null 和空串
- JSON 响应中空串比 null 更自然
- 空串在 Markdown 渲染器中安全无副作用

**备选方案：** NULL —— 被拒绝，理由是前端渲染时需要额外做 null 检查，且 `JSON.stringify` 输出 `null` 不如 `""` 友好。

### Decision 2：bio 存储原始 Markdown，由前端渲染

**选择：** 数据库存原始 Markdown 文本，前端用 Markdown 渲染库（如 `markdown-it`）渲染为 HTML。

**理由：**

- 后端不做 HTML 转换，保持数据原始性
- 前端渲染可充分利用已有的 Markdown 渲染组件
- 后续切换渲染引擎无需迁移数据

**风险：** XSS 注入 —— 前端 Markdown 渲染器需要开启 XSS 过滤（如 `DOMPurify`），不可直接输出 innerHTML。

### Decision 3：PUT /api/v1/users/me 作为更新端点

**选择：** 在 `routes/users.ts` 中新增 `PUT /api/v1/users/me`，放在 `/:id/profile` 之前注册，避免 Hono 路由将 `me` 匹配为 `:id`。

**理由：**

- `/me` 表示"当前用户"，语义清晰
- 用户资料更新属于 users 资源而非 auth 资源
- 与已有的 `GET /api/v1/auth/me` 分工明确：auth 管认证信息，users 管个人资料

### Decision 4：bio 长度限制 5000 字

**选择：** 最大 5000 字符（UTF-8 字符数，非字节）。

**理由：**

- Markdown 格式的个人简介通常不会超过此长度
- 防止数据库 TEXT 字段的极端大值写入（理论上 TEXT 上限 64KB，但 5000 字作为业务限制合理）
- 对应 typical 自介绍 + Markdown 语法标记的合理上限

## Risks / Trade-offs

| 风险 | 缓解措施 |
|------|---------|
| **XSS 注入**：用户 bio 包含恶意 `<script>` 标签 | 前端 Markdown 渲染器强制使用 `DOMPurify` 或类似 XSS 过滤库，禁止 `dangerouslySetInnerHTML` 用法 |
| **Markdown 渲染性能**：极端复杂或嵌套的 Markdown | 前端设置渲染超时（如 500ms），超时后降级为纯文本显示 |
| **路由冲突**：`PUT /api/v1/users/me` 与 `PUT /api/v1/users/:id` 可能在将来冲突 | Hono 中路由按注册顺序匹配，`/me` 放在 `/:id` 之前即可解决。后续若添加 `PUT /api/v1/users/:id` 管理员接口，需注意顺序 |
| **UTF-8 长度**：5000 字符在底层存储中占用可能超过 15KB（中文 + Markdown） | TEXT 类型在 PostgreSQL 中上限 1GB，无实际风险 |
