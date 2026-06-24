## 1. 组件拆解与基础架构

- [x] 1.1 创建 `PaginationNav.vue` 分页导航组件（页码按钮、上一页/下一页、当前页高亮、首尾页禁用态）
- [x] 1.2 创建 `ProblemFilterBar.vue` 筛选栏组件（搜索框防抖、难度单选按钮组、分类下拉选择器）
- [x] 1.3 创建 `StatusBadge.vue` 通过状态徽标组件（已解决/尝试过/未开始三种状态图标与配色）

## 2. 后端改造

- [x] 2.1 `noj-core` keyword 搜索扩展为同时匹配题号（problems.id ILIKE）

## 3. 重构题目列表页

- [x] 3.1 重写 `pages/problems.vue`：使用 URL 查询参数作为状态源（`keyword`、`difficulty`、`category_id`、`page`、`limit`），通过 `useRoute().query` 读取、`router.push({ query })` 更新
- [x] 3.2 集成 `ProblemFilterBar.vue`：搜索触发 `keyword` 参数更新并重置页码，难度筛选更新 `difficulty` 参数，分类筛选更新 `category_id` 参数
- [x] 3.3 集成 `PaginationNav.vue`：监听 `totalPages` 变化，翻页时更新 `page` 参数，筛选变更时自动重置到第 1 页
- [x] 3.4 集成分类数据加载：通过 `GET /api/v1/categories` 获取分类树，客户端缓存，失败时优雅降级（隐藏分类筛选）
- [x] 3.5 集成 `StatusBadge.vue`：已登录用户异步获取已解决题目列表，匹配后显示状态；未登录用户隐藏通过状态列

## 4. 响应式布局与样式优化

- [x] 4.1 表格列响应式适配：桌面端显示全列，移动端（<768px）隐藏时间、内存、分类列
- [x] 4.2 移动端表格行样式优化：确保可点击区域足够、文字不溢出
- [x] 4.3 筛选栏响应式适配：移动端搜索框和筛选控件换行堆叠

## 5. 验证与清理

- [x] 5.1 确认搜索/筛选/分页组合使用时 URL 参数正确同步
- [x] 5.2 确认通过状态在登录/未登录状态下表现正确
- [x] 5.3 确认移动端布局正常，无布局偏移或文字溢出
- [x] 5.4 确认加载中、空数据、错误状态正常展示
