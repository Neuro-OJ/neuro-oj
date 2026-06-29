## 1. 后端服务层（单条重测）

- [ ] 1.1 在 `noj-core/src/services/submissions.ts` 中新增 `rejudgeSubmission(id: string)` 函数

## 2. 后端服务层（批量重测）

- [ ] 2.1 在 `noj-core/src/services/submissions.ts` 中新增 `rejudgeProblemSubmissions(problemId: string, options?)` 函数

## 3. 后端路由层

- [ ] 3.1 在 `noj-core/src/routes/admin.ts` 中新增 `POST /submissions/:id/rejudge` 端点及 import
- [ ] 3.2 在 `noj-core/src/routes/admin.ts` 中新增 `POST /problems/:id/rejudge` 端点及 import

## 4. 前端管理后台提交页

- [ ] 4.1 在 `noj-ui/pages/admin/submissions.vue` 操作列新增"重测"按钮、rejudge 函数、import useToast/useDialog

## 5. 前端管理后台题目列表页

- [ ] 5.1 在 `noj-ui/pages/admin/problems.vue` 操作列新增"重测"按钮、batchRejudge 函数、import useToast/useDialog 和 RefreshCw 图标
