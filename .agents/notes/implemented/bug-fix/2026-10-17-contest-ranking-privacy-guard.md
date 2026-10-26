# Agent Note: 竞赛榜单在已结束未结算时不再泄露全量排名

Status: implemented

## Problem

`getContestRanking` 在竞赛已结束但尚未发布排行榜快照时，对非管理员直接调用
`getKaggleRanking` 返回全量榜单。该分支绕过了 `getContestRankingView` 的隐私
守卫：封榜期与「已结束未结算」状态下，非管理员本应只看到本人一行。REST/SSE
路由目前都走 `getContestRankingView`，但 `getContestRanking` 从域门面导出，
新增调用点即成为越权入口（#656）。

## Decision

删除 `getContestRanking` 中「已结束且无快照 → 直接返回全量榜」的分支，统一委托
`getContestRankingView`：

- 非管理员在封榜窗口内（含已结束未结算）只返回本人一行；匿名得到空列表。
- 未配置封榜的已结束未结算竞赛按结算门禁抛 `ConflictError`，不暴露实时榜。
- 管理员仍可读取全量榜单，结算与运营视图不受影响。

同时从 `noj-core/src/domains/contest/index.ts` 移除 `getContestRanking` 导出。
该函数只被测试引用，测试改为直接从
`services/contest-ranking.ts` 导入，域门面只保留路由使用的
`getContestRankingView`，避免新增生产调用点。函数 JSDoc 明确标注「禁止用于
REST/SSE 路由」。

## Alternatives considered

- **保留导出并加注释**：仍需人工审查调用点，门面继续暴露数组接口，容易再次被
  路由误用。
- **在 `getContestRanking` 内单独按 viewer 过滤**：需要复制封榜/结算门禁逻辑，
  与 `getContestRankingView` 的隐私策略存在漂移风险。
- **删除整个函数**：现有测试与内部计分口径验证仍在使用，删除超出本次修复范围。

## Consequences

- 隐私策略只剩 `getContestRankingView` 一个事实来源，新增视图状态不会漏改。
- `getContestRanking` 不再是域门面 API；跨域调用若需榜单应改用
  `getContestRankingView`。
- 依赖「已结束未结算返回全量榜」的测试改为管理员视角验证计分口径；新增两条
  回归测试分别覆盖非管理员仅本人一行与管理员全量榜单。
- 无数据库迁移、无 REST/SSE 路由行为变化。
