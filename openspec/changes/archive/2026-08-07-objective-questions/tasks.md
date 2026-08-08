## 1. 数据模型与迁移（noj-core）

- [x] 1.1 修改 `src/db/schema.ts`：`problems_type_check` 扩展为 `('U','P','O')`，`runtime_config` 改为可空
- [x] 1.2 新增 `objectiveQuestions` 表（paper_id FK CASCADE、type CHECK single/multiple/judge、options/answer JSONB、UNIQUE(paper_id, sort_order)）
- [x] 1.3 新增 `objectiveSubmissions` 表（paper_id/user_id/contest_id FK、submission_type CHECK、answers/details JSONB、score、部分唯一索引 (paper_id, user_id, contest_id)）
- [x] 1.4 `deno task db:generate` 生成迁移，人工复核 SQL（不带 schema 前缀、约束操作正确）
- [x] 1.5 运行 `deno task test` 验证 `00_migrate_test.ts` 迁移 + 种子兼容

## 2. 客观题类型与判分核心（noj-core）

- [x] 2.1 新增 `src/types/objective.ts`：题型/答案 DTO、校验函数（答案格式、选项合法性）
- [x] 2.2 新增 `src/services/objective-judge.ts`：纯函数判分（三题型集合精确匹配、卷面分 ×100 换算）
- [x] 2.3 新增 `src/services/objective-questions.ts`：小题 CRUD + 套卷详情组装（owner 视图含答案 / 公开视图裁剪）
- [x] 2.4 适配 `src/services/problems-crud.ts`：type='O' 跳过 runtime_config 校验、权限按 U 型规则、删除时级联处理新表
- [x] 2.5 适配 display_id 双索引：`src/routes/problems.ts` `resolveProblem` 正则、`src/services/problems-list.ts` 搜索
- [x] 2.6 新增 `src/services/objective-submissions.ts`：提交（练习重复提交 / 竞赛一次性校验）、历史、最高分查询
- [x] 2.7 新增 `src/routes/objective.ts` 并注册到 `src/app.ts`

## 3. 竞赛集成（noj-core）

- [x] 3.1 `contest-ranking.ts`：evaluated_submissions CTE UNION ALL 客观题提交（满分→Accepted / 非满分→WrongAnswer）
- [x] 3.2 竞赛提交校验服务（竞赛 running、已注册、套卷在题单、无重复提交）接入客观题提交流程

## 4. 单元与路由测试（noj-core）

- [x] 4.1 服务层测试 `tests/services/objective-judge.test.ts`：三题型全对/部分/全错、多选不完全匹配
- [x] 4.2 服务层测试 `tests/services/objective-submissions.test.ts`：练习最高分、竞赛一次性、权限裁剪
- [x] 4.3 路由测试 `tests/routes/objective.test.ts`：套卷 CRUD（type='O'）、小题 CRUD、提交端点、答案可见性
- [x] 4.4 运行 `deno task test` 全量回归 + `deno lint` / `deno fmt` 通过

## 5. 跨模块 E2E（noj-tests）

- [x] 5.1 新增 E2E：建套卷 → 建三题型小题 → 答对/答错提交 → 即时判定落库（objective_submissions）
- [x] 5.2 新增 E2E：练习重复提交取最高分；非 owner 不可见答案
- [x] 5.3 新增 E2E：竞赛集成（套卷挂入 contest_problems、竞赛内一次性提交、排名计入）

## 6. 前端 UI（noj-ui）

- [x] 6.1 新增 `composables/useObjective.ts` 封装套卷/小题/提交 API
- [x] 6.2 套卷列表页 `/objective-papers`（分页、创建入口、owner 管理入口）
- [x] 6.3 套卷详情答题页 `[id].vue`：小题表单（单选 radio / 多选 checkbox / 判断对错）、提交即时判定展示、练习最高分展示
- [x] 6.4 套卷新建/编辑页 `new.vue` / `[id]/edit.vue`：套卷元信息 + 小题编辑器（题型切换、选项增删、答案设定、解析）
- [x] 6.5 竞赛题目页 `contests/[contestId]/problems/[label].vue` 按 type='O' 渲染客观题表单（一次性提交）；Navbar 加入口
- [x] 6.6 `deno lint` / `deno fmt` 通过

## 7. 收尾与归档

- [x] 7.1 全量测试回归（noj-core + noj-tests E2E + CI 相关检查）
- [x] 7.2 `/opsx:archive` 归档变更 + `/opsx:sync` 同步主规范
- [x] 7.3 确认 GPG 签名后按 Conventional Commits（中文描述）提交
