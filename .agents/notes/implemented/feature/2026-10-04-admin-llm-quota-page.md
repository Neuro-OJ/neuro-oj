# Agent Note: 管理后台 LLM 配额编辑页

Status: implemented

## Problem

issue #579：`llm_quotas` 与网关限额逻辑、管理端 `GET/POST /api/v1/admin/gateway/llm/quotas` 均已就绪，但 noj-ui 没有页面，运营者只能手写 HTTP 请求或依赖网关 env 兜底值。

实现过程中还发现几处会让"有了页面也会用错"的问题：

1. **POST 按 id upsert，不带 id 一律新增**：同一 `(scope_type, scope_id, window_type)` 可被重复插入，而网关 `getQuota` 用 `LIMIT 1` 读取，命中行不确定。
2. **seed 占位行不生效**：网关 seed 写入 `scope_id=''` 的 user/problem 行，但计数键按具体 id 精确匹配，这些行永远不会命中；运营者编辑它会误以为改了默认值。
3. **文档语义过期**：`operators/admin-guide.md` 与 `llm-call-capability.md` 写着"`0` 表示不限制但仍计数"，与 2026-09-29 产品决策及网关 Lua（`limit == 0` → `limit_exceeded`）相反；接口路径也漏了 `/gateway` 前缀。
4. **既有 LLM 用量页打不开**：`usage.vue` 的状态筛选以 `''` 作为 `USelect` 选项值，Reka UI 直接抛错导致整页 500。

## Decision

1. 新增 `pages/admin/llm/quotas.vue`（侧栏、顶栏面包屑、命令面板均已登记），纯逻辑放 `utils/llmQuota.ts` 并单测：
   - 取值语义按网关实现展示：`-1` 不限、`0` 禁止调用（红色强调）、正数为上限；限额须为 ≥ -1 的整数（列为 integer）；
   - **新增前查重**：同键已存在时提示并改为携带已有 id 更新，杜绝重复行；未填作用域 ID 时不查重，避免误匹配占位行；
   - 新增时限额可留空，交由网关按 `NOJ_LLM_DEFAULT_*` 填充；编辑时三元组只读（它是计数键）；
   - 占位行在表格中标记「占位（不生效）」，编辑时给出说明。
2. 修正两篇运营文档的取值语义与路径；修正 core `GET /llm/quotas` 已过期的"占位路由"注释。
3. `usage.vue` 状态筛选改用 `all` 哨兵值修复 500。

## Alternatives considered

- **补 DELETE 接口**：删除行是"恢复默认值"最直接的方式，但需改网关 `routes/internal.ts`，而该文件当时在另一个进行中的变更里有未提交修改，为避免冲突本次不做，文档写明暂不支持删除。
- **在网关加唯一约束并改 POST 为按三元组 upsert**：根治重复行，但涉及迁移与网关改动，同上原因留作后续；前端查重已覆盖后台入口。
- **作用域 ID 支持用户名/题号输入并解析为 UUID**：体验更好，但需额外查询接口，首版先提示到对应管理页复制 UUID。

## Consequences

- 运营者可在后台完成配额的查看、新增、修改，操作写 `llm_quota.upsert` 审计。
- 网关测试 `tests/limits_test.ts` 的 `FakeRedis` 仍把 `0` 视为不限，与生产 Lua 不一致，已另行登记跟进。
- `pages/admin/contests.vue` 相似度面板存在同样的空串 `USelect` 选项，已另行登记跟进。
