## 1. 后端新增端点

- [ ] 1.1 在 `noj-core/src/services/auth.ts` 新增 `listUsers()` 服务函数，支持分页查询用户列表
- [ ] 1.2 在 `noj-core/src/routes/auth.ts` 的 `adminAuth` 实例上新增 `GET /api/v1/admin/users` 路由

## 2. 管理后台基础架构

- [ ] 2.1 创建 `noj-ui/middleware/admin.ts` 路由守卫，未登录重定向 `/login`，非管理员重定向 `/`
- [ ] 2.2 创建 `noj-ui/layouts/admin.vue` 管理布局：左侧边栏 + 右侧内容区，响应式折叠
- [ ] 2.3 修改 `noj-ui/components/Navbar.vue`，管理员用户下拉菜单显示"管理后台"入口

## 3. 共享组件

- [ ] 3.1 创建 `noj-ui/components/admin/AdminTable.vue` 通用表格组件（列配置、加载态、空态、操作列插槽）
- [ ] 3.2 创建 `noj-ui/components/admin/AdminModal.vue` 通用确认弹窗组件（标题、内容、确认/取消、ESC 关闭）

## 4. 仪表盘

- [ ] 4.1 创建 `noj-ui/pages/admin/index.vue` 仪表盘页面，展示统计概览卡片（用户数、题目数、提交数）

## 5. 用户管理

- [ ] 5.1 创建 `noj-ui/pages/admin/users.vue` 用户管理页面：分页列表 + 角色切换按钮 + 确认弹窗

## 6. 分类管理

- [ ] 6.1 创建 `noj-ui/pages/admin/categories.vue` 分类管理页面：表格列表 + 行内创建/编辑弹窗 + 删除确认

## 7. 题目管理

- [ ] 7.1 创建 `noj-ui/pages/admin/problems.vue` 题目列表页面（含删除操作）
- [ ] 7.2 创建 `noj-ui/pages/admin/problems/new.vue` 创建题目表单页面（含 `title`, `description`, `judge_image`, `judge_command`, 难度、分类、时间/内存限制等字段）
- [ ] 7.3 创建 `noj-ui/pages/admin/problems/[id]/edit.vue` 编辑题目表单页面（预填充已有数据）

## 8. 提交管理

- [ ] 8.1 创建 `noj-ui/pages/admin/submissions.vue` 提交管理页面：列表 + 多维度筛选控件 + 分页
