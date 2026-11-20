# Agent Note: 清理前端死组件、死 composable 与 CSP 报告端点

Status: implemented

## Problem

issue #726 的静态审查发现 noj-ui 留有一批已无调用方的代码：零引用的
`StatusBadge.vue`，只有组件测试引用的 `ProblemCard.vue`，5 个无人调用的
composable（`useAdminForm`、`useAdminResource`、`useProblemAuthorFields`、
`useResourceRefresh`、`useProblemStats`）和 `utils/problemTemplate.ts`。
语言切换移除后，`utils/i18n.ts` 中约 30% 的键也不再被引用。另外，
`/api/csp-report` 收到报告后直接丢弃，Report-Only CSP 头因此只会产生无效请求。

## Decision

- 删除上述组件、composable、工具函数及只为它们存在的测试。
- 删除 59 个确认零引用的 i18n 键；`error.*` 与面包屑、页面标题用到的键保留。
- 删除 `/api/csp-report` 端点与 Report-Only CSP 头（应用与 nginx 两处），
  正式 CSP 及其余安全头不变。

## Alternatives considered

- 把 CSP 报告写入日志而不是删除：目前没有人消费这些报告，等真正需要收紧 CSP 时
  再连同上报存储一起设计。

## Consequences

- 响应中不再有 `Content-Security-Policy-Report-Only` 头。
- `MarqueeTitle.vue` 只剩 `SubmissionCard.vue` 一个使用方。
