# tags — 题目标签

管理双类标签（`problem` = 题目标签人人可见，`algorithm` =
算法标签通过题目后可见）， 含标签 CRUD、合并（关联重指向 →
删除源标签）与全量列表（含关联题目数）。 原位于
`modules/problems/{routes,services}/tags.ts`。

| 文件                   | 职责                                                                  |
| ---------------------- | --------------------------------------------------------------------- |
| `index.ts`             | 唯一对外出口：`feature` 声明 + 供其他功能/旧模块使用的函数与类型      |
| `routes.ts`            | `/api/v1/tags`、`/tags/:id`、`/tags/:id/merge`（写操作 `tag:manage`） |
| `service.ts`           | 列表、增删改、合并、按名解析；写操作写审计（`tags.*`）                |
| `tests/routes.test.ts` | 路由测试（401/403/2xx）；`deno task test:domain tags`                 |
| `tests/tags.test.ts`   | 服务测试（冲突、级联、合并、审计）                                    |

关键约束：

- 表 `tags` / `problem_tags` 定义在
  `src/shared/db/schema/catalog.ts`，不随本功能移动；
  题目列表等直接查询标签表的代码留在 problems。
- `name` 全局唯一（跨 kind），冲突返回 409；写操作审计主体与 IP 由路由层显式传入
  （`TagWriteContext`），不再依赖 RequestContext 隐式取值。
- 原父路由 `catalogRouter` 无 `use()` 中间件；功能路由显式挂 `no-store` 响应头。
- 标签增删改后为关联题目登记搜索索引任务（best-effort）。
