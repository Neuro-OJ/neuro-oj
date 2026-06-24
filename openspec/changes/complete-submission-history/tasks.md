## 1. 后端 API 扩展

- [ ] 1.1 更新 `services/submissions.ts` 中的 `ListSubmissionsParams` 接口：新增 `problemSearch`、`submissionId`、`userSearch` 可选字段
- [ ] 1.2 在 `listSubmissions` 函数中添加 `problemSearch` 过滤逻辑：`problems.title` ILIKE 模糊匹配 OR `submissions.problem_id` 精确匹配
- [ ] 1.3 在 `listSubmissions` 函数中添加 `submissionId` 过滤逻辑：`submissions.id` ILIKE 前缀匹配
- [ ] 1.4 在 `listSubmissions` 函数中添加 `userSearch` 过滤逻辑：`users.username` ILIKE 模糊匹配 OR `submissions.user_id` 前缀匹配（需添加 LEFT JOIN users）
- [ ] 1.5 更新 `routes/submissions.ts` 用户端路由：解析 `problem_search`、`submission_id` 查询参数传入 `listSubmissions`
- [ ] 1.6 更新 `routes/submissions.ts` 管理端路由：额外解析 `user_search` 查询参数

## 2. 共享逻辑抽取

- [ ] 2.1 创建 `composables/use-submissions.ts`：提取 `SubmissionListItem` 类型、评测状态映射表（标签文字+颜色）、格式化函数（时间、内存、分数、语言标签）
- [ ] 2.2 在 `composables/use-submissions.ts` 中定义状态颜色映射：AC=绿、WA=红、TLE=橙、MLE=橙、RE=红、SE=红、pending=灰、judging=蓝

## 3. 用户提交历史列表页

- [ ] 3.1 创建 `pages/submissions/index.vue`：页面骨架、认证守卫（user 级别）、使用 `/api/v1/submissions` 接口、分页逻辑
- [ ] 3.2 实现筛选栏：题目搜索框（支持题目 ID 和题目名）、提交 ID 搜索框、语言下拉、状态下拉、筛选/清空按钮
- [ ] 3.3 实现状态标签列：根据 `result.status` 或 `status` 显示带颜色的标签
- [ ] 3.4 实现题目列（显示 `problem.title` 带链接）、得分、耗时、内存列
- [ ] 3.5 实现空态、加载态、错误态展示
- [ ] 3.6 集成 PaginationNav 分页组件

## 4. 管理后台提交页改进

- [ ] 4.1 为管理后台筛选栏增加：题目搜索框、提交 ID 搜索框、用户搜索框（用户名/用户 ID 合一）
- [ ] 4.2 为管理后台表格增加得分、耗时、内存列
- [ ] 4.3 替换管理后台状态标签为评测结果状态映射（AC/WA/TLE 等带颜色），并在表格中展示 `problem.title`
- [ ] 4.4 管理后台请求切换到 `/api/v1/admin/submissions`，传入新增的搜索参数

## 5. 验证

- [ ] 5.1 确保后端 `listSubmissions` 支持新的搜索参数，模糊搜索正确工作
- [ ] 5.2 确保用户列表页可正常加载、筛选（含题目模糊搜索、提交 ID 前缀搜索）、分页
- [ ] 5.3 确保管理后台新增搜索框和列正常显示
- [ ] 5.4 确保状态标签颜色正确（AC=绿、WA=红、TLE=橙、pending=灰等）
