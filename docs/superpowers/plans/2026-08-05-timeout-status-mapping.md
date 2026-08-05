# evaluator/solution 超时状态映射实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 明确并固化 evaluator 超时（→ SystemError）与 solution 调用超时（未处理 → TLE、被捕获 → evaluator 决定）的最终状态映射，统一错误帧 code 为 `CallTimeout`，并同步五处文档。

**Architecture:** 在 `noj-judge/src/dual/mod.rs` 新增纯函数 `finalize_outcome`（超时种类 × 是否发过 CallTimeout → 最终状态），`run_dual_loop` 维护 `sent_call_timeout` 标志并在三个收尾分支统一走该函数；总超时（Startup/Total）优先 SystemError，`sent_call_timeout=true` 且无 RESULT → TLE；错误帧 code `"Timeout"` 统一为 `"CallTimeout"`（SDK `runner.py` 同步）。强制终止由既有 `dual.destroy()`（`remove_container_force`）保障，无新增 kill 逻辑。

**Tech Stack:** Rust 2021 + Tokio（noj-judge）、Python 3（evaluator SDK）、Docker（E2E）。

**设计文档:** `docs/superpowers/specs/2026-08-05-timeout-status-mapping-design.md`（已批准）

## Global Constraints

- 状态映射规则（顺序即优先级）：`timed_out.is_some()` → SystemError；`sent_call_timeout` → TimeLimitExceeded；否则 SystemError
- 错误帧 code 统一为 `CallTimeout`，**不保留**旧 code `"Timeout"` 的兼容分支
- `sent_call_timeout` 仅在 `WaitingSide::Evaluator`（evaluator 等 solution 的 call 超时）分支置位；`WaitingSide::Solution`（capability 反向调用超时）不置位
- 代码注释与提交描述使用中文；提交信息格式 `type(scope): 中文描述`（Conventional Commits）
- `cargo fmt` + `cargo clippy` 无警告；E2E 测试带 `#[ignore]` + `#[serial_test::serial]` + `is_e2e_enabled()` 守卫
- 不修改 noj-core / noj-ui；本地提交用 jj（`jj describe`），GPG 签名已配置

---

## 文件结构

| 文件 | 职责 | 动作 |
|------|------|------|
| `noj-judge/src/dual/mod.rs` | `TimeoutKind` enum + `finalize_outcome` 纯函数；`run_dual_loop` 接入（标志 + 分支状态） | 修改 |
| `noj-judge/sdk/evaluator/noj_evaluator_sdk/runner.py` | `_handle_response` 错误码匹配 `"Timeout"` → `"CallTimeout"` | 修改 |
| `noj-judge/sdk/evaluator/noj_evaluator_sdk/tests/test_runner.py` | SDK 单测错误帧 code 断言 | 修改 |
| `noj-judge/tests/e2e_dual_container.rs` | 新增 3 个 E2E 测试；capability 超时断言 code 更新 | 修改 |
| `noj-docs/docs/reference/result-status.md` | TLE/SystemError 定义补充超时来源 | 修改 |
| `noj-docs/docs/problemsetters/rpc.md` | CallTimeout 错误码补充未处理时的状态 | 修改 |
| `noj-docs/docs/problemsetters/judge-model.md` | 新增「超时与状态映射」小节 | 修改 |
| `noj-docs/docs/problemsetters/web-editor.md` | 运行时配置两层超时语义补充 | 修改 |
| `noj-docs/docs/intro/what-is-noj.md` | 时空限制一节状态映射补充 | 修改 |

---

### Task 1: `finalize_outcome` 纯函数 + 单测

**Files:**
- Modify: `noj-judge/src/dual/mod.rs`（`run_dual_loop` 上方新增函数；`mod tests` 模块 `#[cfg(test)] mod tests {` 内新增测试）

**Interfaces:**
- Produces: `enum TimeoutKind { Startup, Total }`、`fn finalize_outcome(timed_out: Option<TimeoutKind>, sent_call_timeout: bool) -> JudgeStatus`（`JudgeStatus` 来自 `crate::types`，已有 `as_str()`）

- [ ] **Step 1: 写失败测试**

在 `noj-judge/src/dual/mod.rs` 的 `mod tests` 内新增（放在 `test_build_judge_result_missing_fields` 之后）：

```rust
#[test]
fn test_finalize_outcome_mapping() {
    // 总超时优先：无论是否发过 CallTimeout 都归 SystemError
    assert_eq!(
        finalize_outcome(Some(TimeoutKind::Startup), false),
        JudgeStatus::SystemError
    );
    assert_eq!(
        finalize_outcome(Some(TimeoutKind::Startup), true),
        JudgeStatus::SystemError
    );
    assert_eq!(
        finalize_outcome(Some(TimeoutKind::Total), false),
        JudgeStatus::SystemError
    );
    assert_eq!(
        finalize_outcome(Some(TimeoutKind::Total), true),
        JudgeStatus::SystemError
    );
    // 无总超时 + 发过 CallTimeout → TLE（用户代码慢是根因）
    assert_eq!(
        finalize_outcome(None, true),
        JudgeStatus::TimeLimitExceeded
    );
    // 无总超时 + 未发过 → SystemError（evaluator 自身异常）
    assert_eq!(
        finalize_outcome(None, false),
        JudgeStatus::SystemError
    );
}
```

注意：`mod tests` 顶部已有 `use super::*;`，可直接引用 `finalize_outcome` / `TimeoutKind`；`JudgeStatus` 需在 `mod tests` 内可用——检查 `mod tests` 现有测试是否引用 `JudgeStatus`（`build_judge_result` 返回 `JudgeResult` 含 `status: String`，可能未直接引用 `JudgeStatus`），若无则测试函数内加 `use crate::types::JudgeStatus;`。

- [ ] **Step 2: 运行测试确认失败**

Run: `cd noj-judge && cargo test finalize_outcome -- --nocapture`
Expected: FAIL（编译错误 `cannot find function finalize_outcome` 或 `cannot find type TimeoutKind`）

- [ ] **Step 3: 最小实现**

在 `run_dual_loop` 函数之前新增：

```rust
/// 超时种类：判定最终状态时区分启动期与正式评测期。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimeoutKind {
    /// 阶段 1：评测程序启动等待超时（容器创建 / 文件注入 / 运行时启动开销）
    Startup,
    /// 阶段 2：evaluator 整体执行超过 time_limit_ms
    Total,
}

/// 评测收尾判定：把「评测如何结束」映射为最终状态。
///
/// 仅在 evaluator 未正常输出 ---RESULT--- 时调用（有 RESULT 走 build_judge_result）。
/// 规则（顺序即优先级）：
/// 1. 总超时（Startup/Total）→ SystemError：评测流程未正常完成，做题人不可通过改代码解决；
/// 2. 曾向 evaluator 发送过 CallTimeout 错误帧 → TimeLimitExceeded：用户代码慢是根因；
/// 3. 否则 → SystemError：evaluator 自身异常。
fn finalize_outcome(timed_out: Option<TimeoutKind>, sent_call_timeout: bool) -> JudgeStatus {
    if timed_out.is_some() {
        return JudgeStatus::SystemError;
    }
    if sent_call_timeout {
        return JudgeStatus::TimeLimitExceeded;
    }
    JudgeStatus::SystemError
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-judge && cargo test finalize_outcome -- --nocapture`
Expected: PASS（1 个测试，6 个断言）

- [ ] **Step 5: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj && jj describe -m "test(judge): finalize_outcome 状态映射纯函数（issue #202）"
```

---

### Task 2: `run_dual_loop` 接入 `finalize_outcome` + `sent_call_timeout` 标志

**Files:**
- Modify: `noj-judge/src/dual/mod.rs`（`run_dual_loop` 函数体）

**Interfaces:**
- Consumes: Task 1 的 `finalize_outcome` / `TimeoutKind`
- Produces: `run_dual_loop` 行为变更——阶段 1/2 超时返回 SystemError；无 RESULT 退出时按 `sent_call_timeout` 判定 TLE/SystemError

- [ ] **Step 1: 写失败测试（行为验证：现无单测覆盖 run_dual_loop 分支，以 Task 4 E2E 为验收；本任务以编译 + 既有测试不回归为准）**

说明：`run_dual_loop` 依赖真实容器 exec 流，无法单测；本任务步骤 2 的「测试」为 `cargo test` 全量回归（既有 `dual/mod.rs` 单测与 `runner.rs` 单测必须保持通过——它们不覆盖 run_dual_loop 分支，不受行为变更影响）。

- [ ] **Step 2: 实现——声明标志并改造三个收尾分支**

在 `run_dual_loop` 中 `let mut tracker = InFlightTracker::new(default_call_timeout_ms);` 之后新增：

```rust
// 是否向 evaluator 发送过 CallTimeout 错误帧（solution 调用超时）。
// 仅 WaitingSide::Evaluator（evaluator 等 solution 的 call）置位；
// WaitingSide::Solution（capability 反向调用超时）不置位——其错误帧写给 solution，
// 不构成「evaluator 未处理 CallTimeout」归因。
let mut sent_call_timeout = false;
```

**改动 1 — 阶段 1 启动超时分支**（现有代码 `return Ok(JudgeResult::timeout(submission_id, "evaluator startup timeout", rejudge_seq));`）替换为：

```rust
return Ok(JudgeResult::system_error(
    submission_id,
    "evaluator startup timeout",
    rejudge_seq,
));
```

**改动 2 — 阶段 2 总超时分支**（现有代码 `return Ok(JudgeResult::timeout(submission_id, "evaluator total timeout", rejudge_seq));`）替换为：

```rust
return Ok(JudgeResult::system_error(
    submission_id,
    "evaluator total timeout",
    rejudge_seq,
));
```

**改动 3 — 两处 in-flight 到期分支**（阶段 1 与阶段 2 各有一处，代码相同）中，`WaitingSide::Evaluator` 分支改为：

```rust
WaitingSide::Evaluator => {
    write_timeout_frame(&mut eval_input, &id).await?;
    sent_call_timeout = true;
}
```

`WaitingSide::Solution` 分支保持不变。

**改动 4 — 无 RESULT 收尾分支**：现有 `None => { ... Ok(JudgeResult::system_error(submission_id, &full_output, rejudge_seq)) }` 的返回值改为：

```rust
match finalize_outcome(None, sent_call_timeout) {
    JudgeStatus::TimeLimitExceeded => Ok(JudgeResult::timeout(
        submission_id,
        &full_output,
        rejudge_seq,
    )),
    _ => Ok(JudgeResult::system_error(
        submission_id,
        &full_output,
        rejudge_seq,
    )),
}
```

（`full_output` 收集逻辑与 warn 日志保持不变。）

- [ ] **Step 3: 运行测试确认通过**

Run: `cd noj-judge && cargo test --lib`
Expected: PASS（`finalize_outcome` 单测 + 既有 `dual/mod.rs` / `tracker.rs` / `types.rs` 单测全部通过）

- [ ] **Step 4: 运行 fmt + clippy**

Run: `cd noj-judge && cargo fmt --check && cargo clippy --all-targets -- -D warnings`
Expected: 无输出（通过）

- [ ] **Step 5: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj && jj describe -m "fix(judge): evaluator 总超时归 SystemError、CallTimeout 未处理归 TLE（issue #202）"
```

---

### Task 3: 错误帧 code 统一为 `CallTimeout`

**Files:**
- Modify: `noj-judge/src/dual/mod.rs`（`write_timeout_frame`）
- Modify: `noj-judge/sdk/evaluator/noj_evaluator_sdk/runner.py`（`_handle_response`）
- Modify: `noj-judge/sdk/evaluator/noj_evaluator_sdk/tests/test_runner.py`（错误帧 code 断言）
- Modify: `noj-judge/tests/e2e_dual_container.rs`（`dual_capability_timeout_per_call` 中 code 断言）

**Interfaces:**
- Produces: 错误帧 `{"type":"error","id":...,"code":"CallTimeout","message":"call timeout"}`；SDK `SolutionTimeoutError` 仅在 `code == "CallTimeout"` 时抛出

- [ ] **Step 1: 写失败测试（SDK 单测先改）**

修改 `noj-judge/sdk/evaluator/noj_evaluator_sdk/tests/test_runner.py` 第 227 行附近：

```python
                    "code": "CallTimeout",
```

（原为 `"code": "Timeout"`，其余断言不变——`errors.get("e")` 应为 `SolutionTimeoutError`。）

- [ ] **Step 2: 运行 SDK 测试确认失败**

Run: `cd noj-judge/sdk/evaluator && python3 -m unittest discover -s tests -v`
Expected: FAIL（`_handle_response` 对 `code == "CallTimeout"` 不抛 `SolutionTimeoutError`，断言 `isinstance(..., SolutionTimeoutError)` 失败）

- [ ] **Step 3: 实现——judge 与 SDK 同步修改**

`noj-judge/src/dual/mod.rs` 的 `write_timeout_frame`：

```rust
let frame = serde_json::json!({
    "type": "error",
    "id": id,
    "code": "CallTimeout",
    "message": "call timeout",
});
```

`noj-judge/sdk/evaluator/noj_evaluator_sdk/runner.py` 第 319 行：

```python
            if code == "CallTimeout":
                raise SolutionTimeoutError(message)
```

（不保留 `"Timeout"` 兼容分支。）

- [ ] **Step 4: 运行测试确认通过**

Run: `cd noj-judge/sdk/evaluator && python3 -m unittest discover -s tests -v`
Expected: PASS（全部 SDK 单测）

Run: `cd noj-judge && cargo test --lib`
Expected: PASS

- [ ] **Step 5: 更新 E2E 断言（capability 超时帧 code）**

`noj-judge/tests/e2e_dual_container.rs` 的 `dual_capability_timeout_per_call` 中（约第 891 行）断言 `"Timeout"` 处改为：

```rust
assert_eq!(
    ...,
    "CallTimeout",
    ...
);
```

（以该处现有断言结构为准，仅替换字符串字面量。）

- [ ] **Step 6: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj && jj describe -m "fix(judge,sdk): 超时错误帧 code 统一为 CallTimeout（issue #202）"
```

---

### Task 4: E2E 三种超时场景测试

**Files:**
- Modify: `noj-judge/tests/e2e_dual_container.rs`（文件末尾追加 3 个测试）

**Interfaces:**
- Consumes: Task 2 行为变更、Task 3 code 变更
- Produces: 三个 `#[ignore]` E2E 测试：`dual_evaluator_total_timeout_system_error` / `dual_solution_timeout_unhandled_tle` / `dual_solution_timeout_handled_wrong_answer`

- [ ] **Step 1: 写测试 1——evaluator 总超时 → SystemError**

在 `e2e_dual_container.rs` 末尾追加：

```rust
/// evaluator 整体超时（time_limit_ms 到期）→ SystemError（评测流程未正常完成）。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn dual_evaluator_total_timeout_system_error() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_sdk_images(&docker).await.unwrap();

    // evaluator：打印首行（进入阶段 2）后死循环，永不输出 ---RESULT---
    let evaluator_cmd = r#"python3 -c "
import sys, time
print('ready', flush=True)
while True:
    time.sleep(1)
""#;
    let runtime_config = RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-e2e-sdk-evaluator:latest".to_string(),
            command: evaluator_cmd.to_string(),
            time_limit_ms: 2000, // 2s 总超时
            memory_limit_mb: 256,
            network: None,
        },
        solution: SolutionRuntime {
            image: "noj-e2e-sdk-solution:latest".to_string(),
            entry: "solution.py".to_string(),
            call_timeout_ms: 5000,
            memory_limit_mb: 128,
        },
    };

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        noj_judge::dual::evaluate_dual(
            docker.clone(),
            "e2e-evaluator-total-timeout",
            &runtime_config,
            "def solve(): return 1",
            "solution.py",
            None,
            "/tmp/e2e-cache",
            100,
            64,
            None,
        ),
    )
    .await
    .expect("评测 30s 外层超时")
    .expect("评测应正常返回");

    assert_eq!(
        result.status, "SystemError",
        "evaluator 总超时应归 SystemError: {:?}",
        result
    );
}
```

- [ ] **Step 2: 运行测试 1 确认通过**

Run: `cd noj-judge && NOJ_RUN_E2E=1 cargo test --test e2e_dual_container dual_evaluator_total_timeout_system_error -- --ignored --nocapture`
Expected: PASS（约 2s 后返回 SystemError）

- [ ] **Step 3: 写测试 2——solution 超时未处理 → TLE**

在文件末尾追加：

```rust
/// solution 调用超时且 evaluator 未捕获（evaluate.py 崩溃、无 ---RESULT---）→ TLE。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn dual_solution_timeout_unhandled_tle() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_sdk_images(&docker).await.unwrap();

    // evaluator：调用 sleep_solution 但不捕获 SolutionTimeoutError → 异常冒泡崩溃退出
    let evaluator_cmd = r#"python3 -c "
from noj_evaluator_sdk import SolutionRunner
runner = SolutionRunner()
runner.call('sleep_solution')
"#;
    let runtime_config = RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-e2e-sdk-evaluator:latest".to_string(),
            command: evaluator_cmd.to_string(),
            time_limit_ms: 15000,
            memory_limit_mb: 256,
            network: None,
        },
        solution: SolutionRuntime {
            image: "noj-e2e-sdk-solution:latest".to_string(),
            entry: "solution.py".to_string(),
            call_timeout_ms: 100, // 100ms 调用超时
            memory_limit_mb: 128,
        },
    };
    // solution：sleep_solution 睡 300ms（> 100ms 调用超时）
    let code = "import time\ndef sleep_solution():\n    time.sleep(0.3)\n    return 1\n";

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        noj_judge::dual::evaluate_dual(
            docker.clone(),
            "e2e-solution-timeout-unhandled",
            &runtime_config,
            code,
            "solution.py",
            None,
            "/tmp/e2e-cache",
            100,
            64,
            None,
        ),
    )
    .await
    .expect("评测 30s 外层超时")
    .expect("评测应正常返回");

    assert_eq!(
        result.status, "TimeLimitExceeded",
        "CallTimeout 未处理应归 TLE: {:?}",
        result
    );
}
```

- [ ] **Step 4: 运行测试 2 确认通过**

Run: `cd noj-judge && NOJ_RUN_E2E=1 cargo test --test e2e_dual_container dual_solution_timeout_unhandled_tle -- --ignored --nocapture`
Expected: PASS（约 100ms 后 evaluator 崩溃退出 → TLE）

- [ ] **Step 5: 写测试 3——solution 超时被捕获 → evaluator 决定（WrongAnswer）**

在文件末尾追加：

```rust
/// solution 调用超时被 evaluator 捕获 → 最终状态由 evaluator 决定（此处为 WrongAnswer）。
#[ignore]
#[serial_test::serial]
#[tokio::test]
async fn dual_solution_timeout_handled_wrong_answer() {
    if !is_e2e_enabled() {
        return;
    }
    let docker = get_docker().expect("docker");
    common::ensure_sdk_images(&docker).await.unwrap();

    // evaluator：捕获 SolutionTimeoutError 后记为失败用例（WrongAnswer）
    let evaluator_cmd = r#"python3 -c "
from noj_evaluator_sdk import SolutionRunner, SolutionTimeoutError, result
runner = SolutionRunner()
try:
    runner.call('sleep_solution')
    result.accept(score=1000, details={'cases': [{'id': 'c1', 'status': 'Accepted'}]})
except SolutionTimeoutError:
    result.wrong_answer(
        score=0,
        message='c1 call timeout',
        details={'cases': [{'id': 'c1', 'status': 'WrongAnswer'}]},
    )
"#;
    let runtime_config = RuntimeConfig {
        evaluator: EvaluatorRuntime {
            image: "noj-e2e-sdk-evaluator:latest".to_string(),
            command: evaluator_cmd.to_string(),
            time_limit_ms: 15000,
            memory_limit_mb: 256,
            network: None,
        },
        solution: SolutionRuntime {
            image: "noj-e2e-sdk-solution:latest".to_string(),
            entry: "solution.py".to_string(),
            call_timeout_ms: 100,
            memory_limit_mb: 128,
        },
    };
    let code = "import time\ndef sleep_solution():\n    time.sleep(0.3)\n    return 1\n";

    let result = tokio::time::timeout(
        Duration::from_secs(30),
        noj_judge::dual::evaluate_dual(
            docker.clone(),
            "e2e-solution-timeout-handled",
            &runtime_config,
            code,
            "solution.py",
            None,
            "/tmp/e2e-cache",
            100,
            64,
            None,
        ),
    )
    .await
    .expect("评测 30s 外层超时")
    .expect("评测应正常返回");

    assert_eq!(
        result.status, "WrongAnswer",
        "CallTimeout 被捕获时状态由 evaluator 决定: {:?}",
        result
    );
}
```

- [ ] **Step 6: 运行测试 3 确认通过**

Run: `cd noj-judge && NOJ_RUN_E2E=1 cargo test --test e2e_dual_container dual_solution_timeout_handled_wrong_answer -- --ignored --nocapture`
Expected: PASS（最终状态 WrongAnswer）

- [ ] **Step 7: 全量 E2E 回归**

Run: `cd noj-judge && NOJ_RUN_E2E=1 cargo test --test e2e_dual_container -- --ignored`
Expected: PASS（既有 10 个测试 + 新增 3 个，含 Task 3 更新过的 capability 超时断言）

- [ ] **Step 8: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj && jj describe -m "test(judge): 补 evaluator 超时/CallTimeout 未处理/被捕获三种 E2E（issue #202）"
```

---

### Task 5: 文档五处更新

**Files:**
- Modify: `noj-docs/docs/reference/result-status.md`
- Modify: `noj-docs/docs/problemsetters/rpc.md`
- Modify: `noj-docs/docs/problemsetters/judge-model.md`
- Modify: `noj-docs/docs/problemsetters/web-editor.md`
- Modify: `noj-docs/docs/intro/what-is-noj.md`

**Interfaces:** 无（纯文档）

- [ ] **Step 1: `reference/result-status.md`**

`TimeLimitExceeded` 一节（现为一句「提交超过时间限制。超时可能发生在 evaluator 执行、用户函数调用或整体评测流程中。」）替换为：

```markdown
## TimeLimitExceeded

提交超过时间限制。超时来源分两类：

- **单次调用超时**（`call_timeout_ms`）：用户函数单次调用超过调用级超时。Judge Worker 向 evaluator 注入 `CallTimeout` 错误；若 evaluator 未捕获（evaluate.py 异常退出、无 `---RESULT---`），最终状态为 `TimeLimitExceeded`。若 evaluator 捕获并记为失败用例，最终状态由 evaluator 决定（如 `WrongAnswer`）。
- **整体流程超时**（`time_limit_ms`）：evaluator 整体执行超过时限，由 Judge Worker 强制终止评测，最终状态为 `SystemError`（见下），**不会**落成 `TimeLimitExceeded`。
```

`SystemError` 一节的「在当前双容器 Python 模型下，下面这些情况通常更容易得到 `SystemError`」列表补充两项：

```markdown
- evaluator 整体执行超过 `time_limit_ms`（Judge Worker 强制终止）。
- evaluator 启动超时（评测环境未就绪）。
```

- [ ] **Step 2: `problemsetters/rpc.md`**

错误来源表（「常见错误来源」中 `CallTimeout` 一行）由：

```markdown
| `CallTimeout` | Judge Worker | 单次调用超过调用级 `timeout_ms`（缺省回退题目级 `call_timeout_ms`）；capability 调用按注册时配置的默认超时 |
```

改为：

```markdown
| `CallTimeout` | Judge Worker | 单次调用超过调用级 `timeout_ms`（缺省回退题目级 `call_timeout_ms`）；capability 调用按注册时配置的默认超时。该错误由 Judge 直接注入；若 evaluator 未捕获（evaluate.py 异常退出、无 `---RESULT---`），最终状态为 `TimeLimitExceeded` |
```

- [ ] **Step 3: `problemsetters/judge-model.md`**

在「结果状态」相关小节后新增：

```markdown
### 超时与状态映射

两层超时的最终状态映射：

| 超时来源 | 触发 | 最终状态 |
| --- | --- | --- |
| evaluator 整体执行超时 | 评测总时长超过 `time_limit_ms` | `SystemError`（Judge Worker 强制终止，做题人不可通过改代码解决） |
| 单次调用超时且 evaluator 未捕获 | 调用超过 `call_timeout_ms`，evaluate.py 异常退出、无 `---RESULT---` | `TimeLimitExceeded` |
| 单次调用超时且 evaluator 捕获 | 同上，但 evaluator 记为失败用例 | 由 evaluator 决定（如 `WrongAnswer`） |
```

（若文档中已有相近小节，合并扩展而非重复新增。）

- [ ] **Step 4: `problemsetters/web-editor.md`**

「运行时配置」中两层超时说明处（`call_timeout_ms` 作为单次 SDK 调用的**默认**超时……合理设置 Solution 的调用超时可以防止用户代码死循环拖垮整场评测）之后补充：

```markdown
两层超时的状态语义：`time_limit_ms` 超时表示评测流程未正常完成，最终状态为 `SystemError`；`call_timeout_ms` 超时若未被 evaluator 捕获，最终状态为 `TimeLimitExceeded`，捕获后由 evaluator 自行决定（详见[评测模型](judge-model.md)）。
```

- [ ] **Step 5: `intro/what-is-noj.md`**

「时空限制」一节（第 82 行附近「**单次调用超时**：`call_timeout_ms` 限制**一次** `runner.call()` 的时长。单次调用超时**不一定**是最终 TLE——evaluator 可以把它当作一个失败用例继续评测，也可以直接判定 TLE。」）之后补充：

```markdown
若 evaluator 未捕获单次调用超时（evaluate.py 异常退出），最终状态为 `TimeLimitExceeded`；而 evaluator 整体执行超过 `time_limit_ms` 时，Judge Worker 强制终止评测，最终状态为 `SystemError`。
```

- [ ] **Step 6: 人工检查**

检查五处文档改动与设计文档状态映射表一致（evaluator 超时→SystemError / CallTimeout 未处理→TLE / 捕获→evaluator 决定）；无遗留「TBD/TODO」；链接目标存在。

- [ ] **Step 7: 提交**

```bash
cd /home/xyber-nova/Github/neuro-oj && jj describe -m "docs: 明确 evaluator/solution 超时状态映射（issue #202）"
```

---

## 自检结论

- **Spec 覆盖**：状态映射表 5 行 → Task 2（映射）+ Task 4（E2E 验证）+ Task 5（文档）；code 统一 → Task 3；启动超时 → Task 2 改动 1；模块影响评估（core/ui 不动）→ Global Constraints。
- **占位符**：无 TBD/TODO；所有代码步骤含完整代码。
- **类型一致性**：`TimeoutKind::{Startup,Total}`、`finalize_outcome(Option<TimeoutKind>, bool) -> JudgeStatus`、`sent_call_timeout: bool` 在 Task 1/2 定义与使用一致；`SolutionTimeoutError` 在 Task 3/4 使用一致；E2E 测试名在 Task 4 各步骤一致。
