## 1. 数据库

- [x] 1.1 创建 Drizzle migration：`ALTER TABLE users ADD COLUMN bio TEXT NOT NULL DEFAULT ''`
- [x] 1.2 更新 `db/schema.ts` 中 `users` 表定义，添加 `bio` 字段

## 2. 后端 API

- [x] 2.1 更新 `services/users.ts` 中 `getUserProfile()`：profile 查询 select 增加 `bio` 字段，返回中包含该字段
- [x] 2.2 更新 `routes/users.ts` 中 GET profile 路由：`user` 对象返回 `bio`
- [x] 2.3 新增 `services/users.ts` 中 `updateUserProfile()` 函数：接收 userId 和 bio 参数，执行更新
- [x] 2.4 新增 `routes/users.ts` 中 `PUT /api/v1/users/me` 路由：解析 body、校验长度、调用 service、返回更新后的用户信息
- [x] 2.5 确保 `/me` 路由在 `/:id/profile` 之前注册，避免路由冲突

## 3. 前端——个人主页展示

- [x] 3.1 在用户主页组件中新增 Markdown 渲染区域，展示 `user.bio`
- [x] 3.2 bio 为空时隐藏该区域
- [x] 3.3 引入并配置 Markdown 渲染库（如 `markdown-it` + `DOMPurify`），防范 XSS

## 4. 前端——个人资料编辑

- [x] 4.1 创建或复用个人设置页面，添加 bio 编辑入口
- [x] 4.2 实现 Textarea 编辑器 + Markdown 实时预览
- [x] 4.3 对接 `PUT /api/v1/users/me` API，实现保存功能
- [x] 4.4 保存成功后刷新主页展示

## 5. 测试

- [x] 5.1 数据库 migration 测试：运行 `deno task db:migrate`，验证 bio 列存在
- [x] 5.2 后端测试：`GET /api/v1/users/:id/profile` 返回 bio 字段
- [x] 5.3 后端测试：`PUT /api/v1/users/me` 成功更新 bio
- [x] 5.4 后端测试：未认证用户调用 PUT 返回 401
- [x] 5.5 后端测试：bio 超长返回 400
- [x] 5.6 端到端验证：浏览器中编辑 bio → 保存 → 主页查看渲染效果
- [x] 5.7 编写 E2E 测试：bio 默认为空、认证保护、超长校验、完整 Markdown 写入与读取、bio 清空
