# Agent Note: 浏览器 E2E 使用 Domain 提交详情等待评测结果

Status: implemented

## Problem

浏览器关键流程测试已迁移到 Domain 作答入口，但提交辅助函数仍沿用旧编辑器
测试的未完成迁移：调用了不存在的 `waitForNewVerdict`，结果轮询引用了不存在的
`verdictText(submissionId)`，并且提交后没有返回 Domain 提交号。因此 CI 在
编译测试文件阶段失败，无法进入真实浏览器流程。

## Decision

- 在点击 Domain 编辑器的“提交评测”按钮前监听
  `POST /api/v1/domains/main/submissions`，校验 201 响应并从响应 envelope 读取
  新提交的 `id`。
- 将新提交号传给结果等待辅助函数；辅助函数打开对应的
  `/d/main/submissions/:submissionId` 详情页，轮询页面真实结果卡片中的得分，
  直到评测完成或超时。
- 满分与错误答案场景都按各自提交号等待，不再用上一条卡片的分数猜测新结果，
  也不再依赖旧 `/editor/*` 路由或固定题号。

## Alternatives considered

- 直接读取测试进程的 API 响应并跳过详情页：放弃，因为该门禁的目标是验证浏览器
  提交后的真实 Domain 详情页与结果展示。
- 恢复旧的 `waitForNewVerdict`/历史卡片轮询：放弃，因为它没有在当前 Domain
  合同中实现，且同分连续提交无法可靠区分目标提交。
- 只补类型声明让 CI 编译通过：放弃，因为不会证明提交号、详情页和终态结果链路。

## Consequences

浏览器 E2E 测试现在显式覆盖 Domain 提交响应、提交详情路由和终态得分展示；
在未启用完整浏览器栈时，`deno check e2e/browser/ui_flows.test.ts` 与
`deno task test:browser` 均通过（11 passed / 0 failed / 13 ignored）。真实
Chromium + Core + Judge 的运行结果仍需由 CI/隔离验收提供，不能由类型检查替代。
