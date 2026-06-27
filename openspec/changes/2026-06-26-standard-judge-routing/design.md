## 1. 数据库 Schema 与迁移

### 1.1 字段定义

在 `noj-core/src/db/schema.ts:38-67` 的 `problems` 表新增：

```ts
judge_type: text("judge_type").notNull().default("special"),
```

并增加 CHECK 约束（参考现有 `typeCheck: check("problems_type_check", ...)` 模式）：

```ts
judgeTypeCheck: check(
  "problems_judge_type_check",
  sql`${table.judge_type} IN ('standard', 'special')`,
),
```

### 1.2 迁移 0006

新建 `noj-core/drizzle/0006_problem_judge_type.sql`（参考 0004 / 0005 格式）：

```sql
ALTER TABLE problems ADD COLUMN judge_type text NOT NULL DEFAULT 'special';
ALTER TABLE problems ADD CONSTRAINT problems_judge_type_check
  CHECK (judge_type IN ('standard', 'special'));
UPDATE problems SET judge_type = 'standard' WHERE id = '1003';
```

更新 `noj-core/drizzle/meta/_journal.json`，新增 idx=6 条目：

```json
{
  "idx": 6,
  "version": "7",
  "when": 1751600000,
  "tag": "0006_problem_judge_type",
  "breakpoints": true
}
```

`when` 取大于 `1751400002`（idx=5）的 epoch，确保单调递增。

### 1.3 不需要索引

`judge_type` 取值仅有 2 个，列表筛选是低频管理路径，eq 扫描足够，**不创建索引**。

## 2. 类型定义

### 2.1 仿 `DIFFICULTIES` 模式新增

`noj-core/src/types/problems.ts`（紧跟 L4-12 现有 `DIFFICULTIES`）：

```ts
export const JUDGE_TYPES = ["standard", "special"] as const;
export type JudgeType = typeof JUDGE_TYPES[number];
export function isValidJudgeType(value: string): value is JudgeType {
  return JUDGE_TYPES.includes(value as JudgeType);
}
```

### 2.2 API 类型扩展

`CreateProblemInput`（L34-48）、`UpdateProblemInput`（L53-63）、`ProblemResponseWithCategories`（L85-106）都加 `judge_type` 字段。`ProblemListQuery` 加 `judge_type?: string`。

### 2.3 JudgeTask 消息字段

`noj-core/src/types/index.ts:4-25` `JudgeTask` 接口加 `judge_type?: string`（用 `string` 而非 `JudgeType`，避免跨模块类型泄漏到 Redis wire 格式；Rust 侧 serde 用 `rename_all = "lowercase"` 解析）。

## 3. 服务层改造

### 3.1 `toProblemResponse(row)`（`noj-core/src/services/problems.ts:56-76`）

加 `judge_type: row.judge_type`。

### 3.2 `createProblem()`（`noj-core/src/services/problems.ts:277-370`）

**关键陷阱：** 不可在 insert payload 中显式传 `judge_type: undefined`，否则 Drizzle 会插入 NULL 触发 NOT NULL 违规。

仿 `support_package_path` 处理模式（L338）——仅当 `input.judge_type` 提供时才加入 insert：

```ts
const judge_type = input.judge_type;
if (judge_type !== undefined) {
  if (!isValidJudgeType(judge_type)) {
    throw new BadRequestError(
      `非法判题类型：${judge_type}，仅允许 ${JUDGE_TYPES.join("/")}`,
    );
  }
  // 在 insert payload 中 spread
}
```

### 3.3 `updateProblem()`（`noj-core/src/services/problems.ts:385-454`）

在 `updates` 收集器中加 `judge_type` 分支（**不需要**防御性 delete，它是可变字段，admin 可在切换评测模式时修改）：

```ts
if (input.judge_type !== undefined) {
  if (!isValidJudgeType(input.judge_type)) {
    throw new BadRequestError(...);
  }
  updates.judge_type = input.judge_type;
}
```

### 3.4 `listProblems()`（`noj-core/src/services/problems.ts:115-205`）

仿 `difficulty` 过滤（L126-133）加 `judge_type` 校验与 `eq(problems.judge_type, ...)`。

### 3.5 `createSubmission()`（`noj-core/src/services/submissions.ts:319-330`）

在 `JudgeTask` 字面量加 `judge_type: problem.judge_type`。`getProblem` 返回的 `ProblemResponseWithCategories` 已包含 `judge_type`（3.1 修复）。

## 4. Seed 策略

`noj-core/scripts/seed.ts` **保持** `onConflictDoNothing` 行为不变。problem 1003 改 standard 由 0006 迁移的 `UPDATE` 完成，seed 脚本不引入 `judge_type` 写入（DB 默认 `'special'` 已覆盖）。

## 5. noj-judge 类型

### 5.1 JudgeType 枚举（`noj-judge/src/types.rs`）

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum JudgeType {
    #[default]
    Special,
    Standard,
}
```

### 5.2 JudgeTask 加字段

```rust
#[derive(Debug, Clone, Deserialize)]
pub struct JudgeTask {
    // ... 现有字段 ...
    #[serde(default)]
    pub judge_type: JudgeType,
}
```

`#[serde(default)]` 在字段缺失时调用 enum-level `Default` → `Special`，保证**向前兼容**旧格式消息（来自未升级的 noj-core）。

**反向兼容性陷阱：** 旧 noj-judge 收到新格式消息（带 `judge_type` 字段）会**忽略**该字段（serde 默认行为），仍按 Python 路径走。这意味着滚动部署必须**先升级 noj-judge**。

## 6. noj-judge runner 重构

### 6.1 抽取共享 prepare 函数

从现有 `do_evaluate_with_pool`（`runner.rs:53-115`）L62-79 抽取：

```rust
async fn prepare_workspace_and_archive(
    pool: &Arc<PoolManager>,
    container_id: &str,
    task: &JudgeTask,
    work_dir: &Path,
) -> Result<()> {
    if let Some(zip_data) = container::get_support_package_bytes(task)? {
        container::extract_zip(&zip_data, work_dir).await?;
    }
    container::write_user_code(work_dir, task).await?;
    let max_archive_mb = pool.config().max_archive_mb;
    archive_and_copy(pool.docker(), container_id, work_dir, max_archive_mb).await?;
    Ok(())
}
```

### 6.2 分流逻辑

`do_evaluate_with_pool` 改为 `dispatch_evaluate`（保留 `evaluate_with_pool` 作为入口签名，main.rs:139 无改动），内部：

```rust
match task.judge_type {
    JudgeType::Special => {
        // 现有路径：执行 task.judge_command + process_output
    }
    JudgeType::Standard => {
        // 调用 run_standard_evaluate
        let (stdout, stderr, exit_code, time_ms, memory_kb) =
            standard::run_standard_evaluate(pool, container_id, work_dir, task).await?;
        // 构造 ContainerOutput 后走 process_output（统一 ---RESULT--- 解析）
        let output = ContainerOutput { stdout, stderr, exit_code };
        let mut result = process_output(task, &output);
        result.time_ms = Some(time_ms);
        result.memory_kb = Some(memory_kb);
        Ok(result)
    }
}
```

### 6.3 legacy 路径

`evaluate_legacy`（`runner.rs:117-139`）内部加分支：`Standard` 时返回 `JudgeResult::system_error(...)` 并打日志"standard not supported on legacy path; deploy new noj-judge pool mode"。**不创建**额外的 `dispatch_legacy` 包装。

## 7. standard.rs 算法

### 7.1 文件位置

新建 `noj-judge/src/judge/standard.rs`，导出 `pub mod standard;` from `judge/mod.rs`。

### 7.2 数据结构

```rust
struct TestCase {
    id: String,
    input: String,
    expected: String, // str(expected).strip() 后
}

struct RunnerOutput {
    stdout: String,
    stderr: String,
    exit_code: i64,
    time_ms: u64,
    memory_kb: u64,
}

struct CaseResult {
    id: String,
    input: String,
    expected: String,
    actual: String,
    content_ok: bool,
    stderr: Option<String>,
}

struct ScoreReport {
    visible: SplitReport,
    hidden: SplitReport,
    hidden_provided: bool,
}

struct SplitReport {
    passed: u32,
    total: u32,
    all_valid_int: bool,
    cases: Vec<CaseResult>,
}
```

### 7.3 纯函数 `score_cases`（核心单元测试目标）

```rust
fn score_cases(cases: &[TestCase], outputs: &[RunnerOutput]) -> ScoreReport { ... }
```

输出字段严格对照 `evaluate.py:148-158` 的 JSON shape：`score_content = 8.0 * total_passed / total_cases`、`score_format = 2.0 if format_ok else 0.0`、`status = "Accepted" if total_score == 10.0 else "WrongAnswer"`、`score = (total_score * 100) as i32`。

### 7.4 Orchestrator `run_standard_evaluate`

```rust
pub async fn run_standard_evaluate(
    pool: &Arc<PoolManager>,
    container_id: &str,
    work_dir: &Path,
    task: &JudgeTask,
) -> Result<(String, String, i64, u64, u64)> {
    // 1. 解析 visible.jsonl / hidden.jsonl（缺失/空 → hidden_provided=false）
    // 2. 对每个 case：
    //    - 写 work_dir/case.in.N（用索引，不用 id，防路径穿越）
    //    - docker exec: sh -c "python3 /tmp/main.py < /tmp/case.in.N"
    //    - per-case timeout = task.time_limit_ms
    //    - exit_code=-1 → 标记 TLE 并终止后续 case
    //    - exit_code=137 → 标记该 case MLE，但不中断其他 case
    //    - exit_code=其他非零 → 该 case stdout="" (内容失败、格式失败)
    // 3. output_line = stdout.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("")
    //    （对照 Python splitlines()[-1]：取最后非空行）
    // 4. content_ok = output_line == expected
    // 5. all_valid_int = 所有 case "int parse 不抛"
    // 6. total_cases == 0 → SystemError("no test cases")
    // 7. total_score = 8.0 * total_passed / total_cases + 2.0 if format_ok
    // 8. status: total_score == 10.0 ? "Accepted" : "WrongAnswer"
    // 9. memory_kb = outputs.iter().map(|o| o.memory_kb).max()
    // 10. time_ms = outputs.iter().map(|o| o.time_ms).sum()
    // 11. stdout 拼接人类可读日志（对照 evaluate.py:138-143）
    // 12. 末尾输出 ---RESULT---\n + json.dumps(report, ensure_ascii=False)
    // 13. 返回 (stdout, stderr="", exit_code=0, time_ms, memory_kb)
}
```

### 7.5 stdin 注入

bollard exec API 不支持 stdin pipe。改用 shell 重定向：

```rust
let cmd = vec![
    "sh".into(),
    "-c".into(),
    format!("python3 /tmp/main.py < /tmp/case.in.{}", case_index),
];
```

`work_dir` 通过 `pool::copy::archive_and_copy` 已挂载到容器 `/tmp`。

### 7.6 文件路径安全

`/tmp/case.in.N` 使用 case 在数组中的**索引**（纯数字），不用 JSONL 字段 `id`，防御 author-controlled JSONL 的路径穿越。

## 8. 前端改造

### 8.1 ProblemEditor.vue（`noj-ui/components/ProblemEditor.vue`）

- 加 `judgeType = ref("special")` 状态
- L53-81 `loadProblem`：响应类型加 `judge_type: string`；赋值 `judgeType.value = p.judge_type || "special"`
- L96-104 `validate()`：校验 `JUDGE_TYPES` 范围
- L106-144 `handleSubmit`：PUT/POST body 都加 `judge_type: judgeType.value`
- L248-270 "评测配置" section 加 `<select>` 控件
- `pages/admin/problem-new.vue` / `problem-edit/[id].vue` **不动**（已 delegate）

### 8.2 列表页（`noj-ui/pages/problems.vue`）

- `ProblemItem` 接口（L7-22）加 `judge_type: string`
- 表格新增"判题"列：`judge_type === "special"` 显示橙色 SPJ 徽章，standard 不显示

### 8.3 详情页（`noj-ui/pages/problems/[id].vue`）

- 接口加 `judge_type: string`
- L138-150 metadata strip：`judge_type === "special"` 时显示小 SPJ 徽章

## 9. 滚动部署 Runbook

**关键顺序：** noj-judge 必须**先于** noj-core 升级。

```
1. 部署新 noj-judge（含 JudgeType 字段处理 + standard.rs）
   - 新 worker 对旧消息（无 judge_type）默认 Special → 行为不变 ✓
2. 等待 noj-judge fleet 全部更新（至少一轮滚动完成）
3. 部署新 noj-core（含 judge_type 字段写入 JudgeTask）
   - 新 noj-core 对 problem 1003 发送 judge_type="standard" → 新 worker 走 standard 路径 ✓
```

**反向回滚顺序：** 先回滚 noj-core，再回滚 noj-judge。

**危险组合（必须避免）：**
- 旧 noj-judge + 新 noj-core：旧 worker 忽略 judge_type 字段，problem 1003 走 Python evaluate.py 路径 → 但 evaluate.py 已不包含 → SystemError
- 新 noj-judge + 旧 noj-core：旧 noj-core 不发送 judge_type，新 worker 默认 Special → 行为正确 ✓

## 10. 测试策略

### 10.1 noj-core 单测

- `tests/db/schema.test.ts`：judge_type 列存在 + CHECK 约束违反（`INSERT ... judge_type='invalid'` 应失败）
- `tests/services/problems.test.ts`：
  - 创建时不传 judge_type → 默认 'special'
  - 创建时传 judge_type='standard' → round-trip 读取为 'standard'
  - 更新只传 title → judge_type 不被重置
- `tests/routes/problems.test.ts`：judge_type 字段在响应中、非法值返回 400

### 10.2 noj-judge 单测

- `types.rs`：JudgeType serde 测试
  - 缺失字段 → Special（向后兼容）
  - `"standard"` → Standard
  - `"special"` → Special
  - 无效值（如 `"foo"`）→ 反序列化失败（不静默 coerce）
- `standard.rs::score_cases`：纯函数单元测试（无 Docker）
  - 全通过 → score=1000, Accepted
  - 全失败 → score=0, WrongAnswer
  - 内容对 + 格式错（`print("3.0")`）→ score_content=8.0, score_format=0.0, WrongAnswer
  - 用户代码带 debug 输出（`print("debug") + print(42)`）→ output_line = "42"，正确匹配
  - empty visible.jsonl → SystemError
  - hidden.jsonl 缺失 → hidden_provided=false，只基于 visible 评分
  - 单 case stdout 空（用户代码 raise）→ content_ok=false, all_valid_int=false

### 10.3 noj-judge E2E（**最关键**）

- **旧格式消息兼容（最关键回归测试）**：手动 `LPUSH` 旧 JudgeTask（无 judge_type）到 `noj:judge:queue`，确认默认走 Special 路径
- problem 1003 正确提交 → score=1000, status=Accepted
- problem 1003 错误提交 → score=0, status=WrongAnswer
- problem 1003 无限循环 → status=TimeLimitExceeded
- problem 1001（special）路径不被破坏

### 10.4 端到端验证

- noj-core: `deno task test`、`deno fmt`、`deno lint`
- noj-judge: `cargo test`、`cargo fmt`、`cargo clippy`
- 全栈：提交 problem 1003 → 输出 details 与原 evaluate.py 完全一致

## 11. 风险与回滚

- **数据库迁移回滚**：`ALTER TABLE problems DROP CONSTRAINT problems_judge_type_check; ALTER TABLE problems DROP COLUMN judge_type;`
- **Worker 回滚**：先回滚 noj-core 再回滚 noj-judge（与部署顺序相反）
- **Core 回滚**：单独回滚 noj-core 即可，新 worker 已能处理旧消息
- **种子回滚**：problem 1003 改回 special：`UPDATE problems SET judge_type='special' WHERE id='1003';`

## 12. 提交与 PR

- 新建分支 `feat/issue-66-standard-judge-routing`
- 拆 4 个 commit（OpenSpec 提案 / noj-core / noj-judge / noj-ui），全部 GPG 签名
- `gh pr create` body 引用 issue #66、关联 PR #65 / #67、列出验收项