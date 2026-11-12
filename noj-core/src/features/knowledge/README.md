# knowledge — 知识图谱

实例级的 AI 竞赛知识图谱：内容包（官方包 + 扩展包）的加载、校验与幂等导入，
为题目挂载知识点、节点阶梯与掌握度提供数据基础。用户文档与完整设计见
[openspec/changes/add-knowledge-graph/](../../../../openspec/changes/add-knowledge-graph/)。

| 文件             | 职责                                                                        |
| ---------------- | --------------------------------------------------------------------------- |
| `index.ts`       | 唯一对外出口：`feature` 声明（含只读路由）与知识图谱能力导出                |
| `pack.ts`        | `loadPackFromDir` / `validatePack` / `resolveOfficialPackDir`               |
| `import.ts`      | `importPack(dir)`：单事务幂等导入，统计新增/更新/废弃节点与边               |
| `graph.ts`       | 只读图视图 + 进程内 TTL 缓存（10 分钟）与 `invalidateKnowledgeGraphCache()` |
| `routes.ts`      | 只读 API：`GET /knowledge/graph`、`GET /knowledge/nodes/:id`                |
| `pack.test.ts`   | 纯函数测试（临时目录构造非法包 + 真实官方包 14 领域 / 181 节点）            |
| `import.test.ts` | 导入测试（真实 PostgreSQL：首导、幂等、替换废弃、扩展、失败不写库）         |
| `routes.test.ts` | API 测试（整图/详情/开关关闭/空库/缓存失效）                                |

## API（只读，挂在 `/api/v1`）

- `GET /knowledge/graph` →
  `{ data: { pack: { id, version } | null, areas: [{ id, name, sort }], nodes: [{ id, area, name, summary, syllabus, requires, doc }] } }`；
  只含 `active` 节点与两端 active 的 `requires`，按领域 sort、节点 sort 排序；
  无已导入包时 `pack: null`、areas/nodes 为空。
- `GET /knowledge/nodes/:id` →
  `{ data: { id, area, name, summary, syllabus, doc, requires, dependents } }`；
  不存在或已废弃 → 404。
- 两个接口采用可选鉴权（未登录可读）；`knowledge_enabled = false` 时返回 404，
  `code: "KNOWLEDGE_DISABLED"`。

## 配置项（`src/shared/config/settings-registry.ts`，分类 `knowledge`，runtime 可热改）

| key                 | 类型 / 默认    | 用途                                   |
| ------------------- | -------------- | -------------------------------------- |
| `knowledge_enabled` | boolean / true | 总开关（env 兜底 `KNOWLEDGE_ENABLED`） |

缓存：图数据在进程内缓存 10 分钟（已登记于
`dev-docs/engineering/domain-boundaries.md` 多副本约束表）；导入新包后同进程立即
失效，其他副本最多 10 分钟内可见。

关键约束：

- 表 `knowledge_packs` / `knowledge_areas` / `knowledge_nodes` /
  `knowledge_edges` 定义在 `src/shared/db/schema/knowledge.ts`。
- 内容包格式：`pack.yaml`（`id`、`name`、`version`、`license`、`syllabi`、 可选
  `extends: official@<version>`）+ `areas/<area>.yaml`；官方包在
  `data/knowledge-graph/`，由仓库根门禁 `scripts/check-knowledge-pack.ts` 校验。
- 节点 ID `<领域>.<名称>` 发布后不得改名或复用；删除只标记 `deprecated`。
- 扩展包（P0 仅支持扩展官方包）导入时被扩展包一并生效，ID 冲突即失败；实例
  任一时刻只有一个包 `active`。
- 导入不删除节点与边以外的历史：废弃节点保留，边按新图整体重写。

测试：`cd noj-core && deno task test:domain knowledge`。
