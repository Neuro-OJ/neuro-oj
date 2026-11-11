# trainings — 域题单

把本域已发布题目编排成有序题单；支持草稿/发布、revision
乐观锁、跨域整份复制（递归复制题目，整批成功或整批失败）。用户文档见
[trainings.md](../../../../noj-docs/docs/features/trainings.md)。

**这是 `src/features/` 的官方样例**：新功能照此目录组织。

| 文件             | 职责                                                                 |
| ---------------- | -------------------------------------------------------------------- |
| `index.ts`       | 唯一对外出口：`feature` 声明 + 供其他功能/旧模块使用的函数与类型     |
| `routes.ts`      | `/api/v1/domains/:slug/trainings*` 与 `/training-bindings`           |
| `service.ts`     | 创建、更新（`If-Match` revision）、删除                              |
| `access.ts`      | 读取、列表、可见性判定；`lockTrainingExpansion` 供作业展开题单时加锁 |
| `copy.ts`        | 跨域复制整份题单                                                     |
| `routes.test.ts` | 路由测试；运行 `cd noj-core && deno task test:domain trainings`      |

关键约束：

- 题单表 `trainings` / `training_problems` 定义在
  `src/shared/db/schema/catalog.ts`（被作业等表外键引用，迁移统一生成）。
- 受比赛保密保护的题目仍显示题号与标题，正文受保护（`loadDomainProblemProtection`）。
- 外部使用方：教学作业（`modules/education`）按题单展开作业题目，经本目录
  `index.ts` 引用。
