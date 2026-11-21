# JudgeTask / JudgeResult wire 契约

> 双容器编排流程见 [flow.md](flow.md)。JSON 字段名与语义**只以**
> [`noj-tests/fixtures/judge-task.contract.json`](../../noj-tests/fixtures/judge-task.contract.json)
> 与 `JUDGE_TASK_FIELDS` 为准，本文只是摘要。

## JudgeTask（noj-core → noj-judge）

```json
{
  "submission_id": "uuid",
  "problem_id": "uuid",
  "user_id": "uuid",
  "priority": "medium",
  "download_url": "noj-download://base64/?content=UEsDBBQAAAAIA...&checksum_sha256=abc123",
  "artifact_download_url": "noj-download://s3?url=...&checksum_sha256=abc123",
  "runtime_config": {
    "evaluator": {
      "image": "noj-evaluator-python",
      "command": "python3 /workspace/evaluate.py",
      "time_limit_ms": 5000,
      "memory_limit_mb": 512
    },
    "solution": {
      "image": "noj-solution-python",
      "call_timeout_ms": 2000,
      "memory_limit_mb": 512
    }
  },
  "language": "python3",
  "code": "...",
  "file_name": "submission.py",
  "rejudge_seq": 1
}
```

> `user_id` 必填；`priority` 缺省 `medium`——Rust 侧带
> `#[serde(default = "default_priority")]`；启用 LLM 的题目另带 `llm`。

> 双容器架构后 `judge_image` / `judge_command` / `time_limit_ms` /
> `memory_limit_mb` 顶层字段已移除，统一由 `runtime_config`（Evaluator +
> Solution）承载。

## JudgeResult（noj-judge → noj-core）

```json
{
  "submission_id": "uuid",
  "status": "finished",
  "score": 1000,
  "output": "---RESULT---\n{\"score\":1000,\"details\":{}}",
  "details": { "cases": [...] },
  "time_ms": 42,
  "memory_kb": null,
  "rejudge_seq": 0,
  "evaluation_protocol_version": 3,
  "run_id": "attempt-uuid",
  "attempt_id": "attempt-uuid",
  "problem_version_id": "version-uuid",
  "result_kind": "graded"
}
```

> **版本化封套（协议 v3，Handbook §5.5/§5.6）**：`main.rs` 在推送前对**全部**
> 成功 / 失败 / 超时结果统一调用 `JudgeResult::apply_protocol`，回显 `run_id`
> （= `evaluation_attempts.id`）、`attempt_id`（缺省回退为 `run_id`，自测任务也
> 因此完整）、`problem_version_id` 与
> `evaluation_protocol_version=3`，并显式给出 `task_kind`、对应运行标识和
> `result_kind`（`graded` / `platform_error`）。协议
> 字段**只**走可信封套，不写入 evaluator 可控的 `details`。`envelope_gaps()` 在
> 推送前复核，不完整时记 error 日志 —— core 会整体拒绝这类结果
> （`applied=false`），提交将卡在 judging。Wire 字段集合由
> [`tests/judge_result_contract.rs`](../tests/judge_result_contract.rs)
> 钉住，平台 错误白名单与 core `shared/versioning/verdict.ts` 同表。
>
> **非法评分（defect #29）**：`---RESULT---` 的 payload 必须是 JSON 对象且
> `score` 为 `0..=10000` 的整数值（与 core `isValidGradedScore` 的
> `Number.isInteger` 语义一致）。缺
> `score`、字符串/非整数/布尔、越界一律转成**平台错误**
> （`result_kind=platform_error`，固定公开文案），**绝不** `unwrap_or(0)` 或
> clamp 成正式零分/满分去覆盖已有成绩。

## 结果字段语义（judge 侧回填）

`time_ms` 回填为 **Solution 忙碌时长**：`InFlightTracker` 统计所有 evaluator →
solution 调用 in-flight 区间的并集（不含容器创建/销毁、注入、 评测脚本自身与 LLM
调用；从未调用时为 `null`），整段墙钟时间只写入 `wall_time_ms` 日志；`memory_kb`
通过销毁前读取一次 Docker stats 尽力回填：

- cgroups v1 使用 `memory_stats.max_usage`（真实峰值）；
- cgroups v2 无 `max_usage` 时回退到 `usage`（近似值）；
- 读取失败或容器不可用时保持 `null`（不阻断评测）。

OOM 容器由 `docker rm -f` 回收；当前仍不单独映射 `MemoryLimitExceeded`
（Solution OOM 由 evaluator/超时路径归因）。
