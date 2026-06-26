## 1. 数据库 Schema 与迁移

- [ ] 1.1 修改 `noj-core/src/db/schema.ts`：problems 表新增 `judge_type` 字段与 CHECK 约束
- [ ] 1.2 新建 `noj-core/drizzle/0006_problem_judge_type.sql`：加列、加约束、UPDATE 1003
- [ ] 1.3 更新 `noj-core/drizzle/meta/_journal.json`：新增 idx=6 条目（when > 1751400002）

## 2. 类型定义

- [ ] 2.1 `noj-core/src/types/problems.ts` 新增 `JUDGE_TYPES` / `JudgeType` / `isValidJudgeType`
- [ ] 2.2 `CreateProblemInput` / `UpdateProblemInput` / `ProblemResponseWithCategories` / `ProblemListQuery` 加 `judge_type`
- [ ] 2.3 `noj-core/src/types/index.ts` `JudgeTask` 加 `judge_type?: string`

## 3. noj-core 服务层

- [ ] 3.1 `services/problems.ts::toProblemResponse` 加 `judge_type`
- [ ] 3.2 `services/problems.ts::createProblem`：仅当输入提供时插入 judge_type（避免 NULL 触发 NOT NULL）
- [ ] 3.3 `services/problems.ts::updateProblem`：加 judge_type 更新分支（不需要防御性 delete）
- [ ] 3.4 `services/problems.ts::listProblems`：加 judge_type 过滤
- [ ] 3.5 `services/submissions.ts::createSubmission`：JudgeTask 字面量加 `judge_type: problem.judge_type`

## 4. noj-judge 类型

- [ ] 4.1 `noj-judge/src/types.rs` 新增 `JudgeType` 枚举（含 `#[default] Special`）
- [ ] 4.2 `JudgeTask` 加 `#[serde(default)] pub judge_type: JudgeType`
- [ ] 4.3 单测：缺失字段默认 Special / 显式 standard / 显式 special / 无效值失败

## 5. noj-judge runner 重构

- [ ] 5.1 从 `do_evaluate_with_pool` 抽取 `prepare_workspace_and_archive` 共享函数
- [ ] 5.2 改 `do_evaluate_with_pool` 为 `dispatch_evaluate`：match task.judge_type 分流
- [ ] 5.3 `evaluate_legacy` 加 Standard 分支（返回 SystemError + 日志）
- [ ] 5.4 `evaluate_with_pool` 与 `evaluate_legacy` 入口签名保持不变（main.rs 无需改动）

## 6. noj-judge standard.rs 新建

- [ ] 6.1 新建 `noj-judge/src/judge/standard.rs` 并在 `judge/mod.rs` 声明
- [ ] 6.2 定义 `TestCase` / `RunnerOutput` / `CaseResult` / `SplitReport` / `ScoreReport` 数据结构
- [ ] 6.3 实现纯函数 `score_cases`（100% 对照 evaluate.py:148-158）
- [ ] 6.4 实现 orchestrator `run_standard_evaluate`：解析 JSONL → 写 case.in.N → sh -c 重定向 → exit_code 处理 → 聚合评分 → 打印 ---RESULT---
- [ ] 6.5 边界处理：empty visible.jsonl → SystemError / 边界超时 / 单 case OOM 不中断
- [ ] 6.6 pure 函数单元测试（全通过、全错、格式错、debug 输出、empty cases、hidden 缺失、stdout 空）

## 7. noj-ui

- [ ] 7.1 `components/ProblemEditor.vue`：加 judgeType ref + 校验 + select 控件 + body 透传
- [ ] 7.2 `pages/problems.vue`：ProblemItem 加 judge_type + 表格新增判题列
- [ ] 7.3 `pages/problems/[id].vue`：数据类型加 judge_type + metadata strip SPJ 徽章

## 8. 测试与验收

- [ ] 8.1 `deno task test`、`deno fmt`、`deno lint`（noj-core）
- [ ] 8.2 `cargo test`、`cargo fmt`、`cargo clippy`（noj-judge）
- [ ] 8.3 E2E：problem 1003 正确提交 → Accepted, score=1000
- [ ] 8.4 E2E：problem 1003 错误提交 → WrongAnswer
- [ ] 8.5 E2E：problem 1003 无限循环 → TimeLimitExceeded
- [ ] 8.6 E2E：problem 1001（special）路径不被破坏
- [ ] 8.7 **E2E 关键回归**：旧格式 JudgeTask（无 judge_type）LPUSH → 默认走 Special 路径
- [ ] 8.8 端到端验证：problem 1003 输出 details 与原 evaluate.py 完全一致

## 9. 提交与 PR

- [ ] 9.1 所有 commit GPG 签名（密钥 `0B8C1EA86578DBB0` 已配置）
- [ ] 9.2 推送 `feat/issue-66-standard-judge-routing` 分支
- [ ] 9.3 `gh pr create` body 引用 issue #66、关联 PR #65/#67、列出验收项
- [ ] 9.4 OpenSpec 同步：使用 `/opsx:sync` 同步 delta specs 到主 spec 目录
- [ ] 9.5 归档：使用 `/opsx:archive` 归档本变更