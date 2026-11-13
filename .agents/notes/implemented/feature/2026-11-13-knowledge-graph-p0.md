# Agent Note: 知识图谱 P0 图谱基座（内容包导入与只读 API）

Status: implemented

## Problem

知识图谱提案（`openspec/changes/add-knowledge-graph`）需要先落地图谱基座：官方内容包（`noj-core/data/knowledge-graph/`，14
领域 / 181 知识点）要能被校验、导入数据库并通过 API
读取，同时满足实例可替换/扩展、可整体关闭、生产镜像为 `deno compile`
二进制等约束。这也是第一个从零按功能切片结构编写的功能。

## Decision

- 代码在
  `src/features/knowledge/`：`pack.ts`（加载与纯函数校验）、`import.ts`（单事务幂等导入）、`graph.ts`（读取与进程内缓存，TTL
  10
  分钟）、`routes.ts`（`GET /api/v1/knowledge/graph`、`/knowledge/nodes/:id`）。
- 表 `knowledge_packs` / `knowledge_areas` / `knowledge_nodes` /
  `knowledge_edges` 定义在 `src/shared/db/schema/knowledge.ts`；迁移 `0139` 由
  `db:generate` 生成，按迁移安全门禁去掉 `"public".` 前缀。
- 导入挂在 `init system` 末尾：开发 `dev-setup`
  与生产迁移容器都会自动导入官方包；另有
  `noj knowledge import [--pack <dir>]`。换包时旧节点标记 `deprecated`
  不删除；同一包重复导入无实际变化。
- 校验规则：ID
  格式与领域前缀、唯一、必填字段、考纲键、前置存在、无自依赖与环、扩展包仅可扩展同版本官方包且不得冲突；**所有节点出现（含重复
  ID）都参与前置检查，错误一次报全**。
- 只登记实际生效的 runtime 配置
  `knowledge_enabled`（新增设置分类「知识图谱」）；关闭时 API 返回 404
  `KNOWLEDGE_DISABLED`。AI 打标、及格线、掌握题数等配置随使用它们的阶段登记——
  预先登记会被 `check-config-usage` 判为只登记不读取的死键。
- 新增门禁 `scripts/check-knowledge-pack.ts` 在 CI 校验官方包。
- 图谱前端浏览页（提案任务 1.6）按用户要求暂缓。

## Alternatives considered

- 导入作为独立部署步骤：需改 noj-cli 与 compose，而 `init system`
  已在每次部署的迁移容器中执行，挂在其后最简单。
- 物理删除旧包节点：会让 P1 起的题目挂载失去引用，改为标记 `deprecated`。

## Consequences

- 已验证：knowledge 域测试 30 通过（真实 PostgreSQL）；临时库上 `db migrate` +
  `init system` 自动导入 181 节点 / 265 边 / 14 领域，再次导入 0
  变化；共享测试与仓库门禁通过。
- 工蜂起草的测试因沙箱连不上数据库未实际运行过，首次运行发现 4 个缺陷（YAML 当
  JSON 解析、用例间未清图缓存、校验器重复 ID 时漏报前置错误），均已修复。
- 官方包路径的「项目根」必须是 noj-core 根（与 `scripts/noj.ts`、生产
  `NOJ_PROJECT_ROOT=/app` 一致）， 初版误按仓库根拼接
  `noj-core/data`，本地仓库布局下恰好可用，E2E 镜像（`/app/src`）迁移容器在
  `init system`
  导入时失败；若合入将导致生产部署迁移失败。已修正并补环境变量与默认路径两条回归测试。
- 「新增功能 ≤6 个手动改动文件」复盘：核心路径（功能目录 + 清单一行 +
  表定义）达标，但仍有登记点：表归属（`module-boundaries.json`）、新设置分类需同步
  `.env.example` 与后台分类标签、进程内缓存需登记
  `domain-boundaries.md`。其中表归属登记最可精简，留作后续。
- 本地开发库迁移记录与代码不一致（第 25 条 `0020_user_rankings_view` hash
  不匹配），与本变更无关，开发库需重建后才能执行新迁移。
