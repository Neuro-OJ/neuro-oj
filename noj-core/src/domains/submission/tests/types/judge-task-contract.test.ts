/**
 * JudgeTask 跨模块契约快照测试（2026-09-12 架构评审 §3.1）。
 *
 * 两侧（noj-core TypeScript / noj-judge Rust）共用同一份 fixture：
 * `noj-tests/fixtures/judge-task.contract.json`。
 *
 * 这里断言的是 **wire 契约**（字段名与取值形态），不依赖数据库：
 * 1. `buildJudgeTask()` 用 fixture 的取值构造出的对象，序列化后必须与 fixture 一致；
 * 2. 字段集合必须与 `JUDGE_TASK_FIELDS` 完全一致（新增字段忘记登记 → 失败）；
 * 3. 可选字段缺省时不出现（保持消息体最小，与 Rust 侧 `skip_serializing_if` 对齐）。
 *
 * Rust 侧的对应断言见 `noj-judge/tests/judge_task_contract.rs`。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  buildJudgeTask,
  JUDGE_TASK_FIELDS,
  type JudgeTask,
} from "../../types/index.ts";

const FIXTURE_URL = new URL(
  "../../../../../../noj-tests/fixtures/judge-task.contract.json",
  import.meta.url,
);

async function loadFixture(): Promise<JudgeTask> {
  return JSON.parse(await Deno.readTextFile(FIXTURE_URL)) as JudgeTask;
}

Deno.test("JudgeTask 契约: 工厂按 fixture 构造出的消息与 fixture 完全一致", async () => {
  const fixture = await loadFixture();
  const built = buildJudgeTask({
    submission_id: fixture.submission_id,
    problem_id: fixture.problem_id,
    user_id: fixture.user_id,
    priority: fixture.priority,
    runtime_config: fixture.runtime_config,
    language: fixture.language,
    code: fixture.code,
    file_name: fixture.file_name,
    download_url: fixture.download_url,
    artifact_download_url: fixture.artifact_download_url,
    rejudge_seq: fixture.rejudge_seq,
    llm: fixture.llm,
    user_llm: fixture.user_llm,
  });
  // 经 JSON 往返比较：同时验证字段集合与值（含嵌套 runtime_config / llm）
  assertEquals(JSON.parse(JSON.stringify(built)), fixture);
});

Deno.test("JudgeTask 契约: 字段集合与登记表一致", async () => {
  const fixture = await loadFixture();
  const built = buildJudgeTask({
    submission_id: fixture.submission_id,
    problem_id: fixture.problem_id,
    user_id: fixture.user_id,
    priority: fixture.priority,
    runtime_config: fixture.runtime_config,
    language: fixture.language,
    code: fixture.code,
    file_name: fixture.file_name,
    download_url: fixture.download_url,
    artifact_download_url: fixture.artifact_download_url,
    rejudge_seq: fixture.rejudge_seq,
    llm: fixture.llm,
    user_llm: fixture.user_llm,
  });
  assertEquals(
    Object.keys(built).sort(),
    [...JUDGE_TASK_FIELDS].sort(),
    "JudgeTask 字段集合变化时必须同步 JUDGE_TASK_FIELDS 与 Rust 结构体",
  );
  // fixture 自身也必须是完整字段集（防止 fixture 落后于契约）
  assertEquals(
    Object.keys(fixture).sort(),
    [...JUDGE_TASK_FIELDS].sort(),
    "契约 fixture 必须包含全部字段",
  );
});

Deno.test("JudgeTask 契约: 可选字段缺省时不写入消息体", () => {
  const built = buildJudgeTask({
    submission_id: "s",
    problem_id: "p",
    user_id: "u",
    priority: "high",
    runtime_config: {
      evaluator: {
        image: "noj-evaluator-python",
        command: "python3 /workspace/evaluate.py",
        time_limit_ms: 1000,
        memory_limit_mb: 256,
      },
      solution: {
        image: "noj-solution-python",
        call_timeout_ms: 500,
        memory_limit_mb: 256,
      },
    },
    language: "python3",
    code: "print(1)",
  });
  assertEquals(Object.keys(built).sort(), [
    "code",
    "language",
    "priority",
    "problem_id",
    "runtime_config",
    "submission_id",
    "user_id",
  ]);
  assert(
    !("download_url" in built) && !("llm" in built) &&
      !("artifact_download_url" in built),
    "可选字段缺省时不应出现在消息体中",
  );
});

Deno.test("JudgeTask 契约: 必填字段齐全时才构造（类型层面已强制，这里验证运行期形态）", async () => {
  const fixture = await loadFixture();
  const built = buildJudgeTask({
    submission_id: fixture.submission_id,
    problem_id: fixture.problem_id,
    user_id: fixture.user_id,
    priority: fixture.priority,
    runtime_config: fixture.runtime_config,
    language: fixture.language,
    code: fixture.code,
  });
  for (const key of ["submission_id", "problem_id", "user_id", "priority"]) {
    assert(
      typeof (built as unknown as Record<string, unknown>)[key] === "string",
      `${key} 必须是字符串`,
    );
  }
  assert(typeof built.runtime_config.evaluator.image === "string");
});
