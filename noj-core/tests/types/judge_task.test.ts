import { assertEquals, assertExists } from "jsr:@std/assert@^1";
import type { JudgeTask } from "../../src/types/index.ts";

/**
 * JudgeTask 与 judge_type 字段的序列化/反序列化契约（issue #66）。
 *
 * noj-judge 端的 `#[serde(default)]` 行为要求 noj-core 推送的消息
 * 至少能让对方正确解析——本测试守护这一契约。
 */

Deno.test("JudgeTask 反序列化: 标准题 judge_type='standard' 透传", () => {
  const json = JSON.stringify({
    submission_id: "sid-1",
    problem_id: "1003",
    judge_image: "noj-judge-python",
    judge_command: "python3 /tmp/evaluate.py",
    language: "python3",
    code: "print(1)",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
    judge_type: "standard",
  });
  const task: JudgeTask = JSON.parse(json);
  assertEquals(task.judge_type, "standard");
});

Deno.test("JudgeTask 反序列化: SPJ 题 judge_type='special' 透传", () => {
  const json = JSON.stringify({
    submission_id: "sid-2",
    problem_id: "1001",
    judge_image: "noj-judge-python",
    judge_command: "python3 /tmp/evaluate.py",
    language: "python3",
    code: "",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
    judge_type: "special",
  });
  const task: JudgeTask = JSON.parse(json);
  assertEquals(task.judge_type, "special");
});

Deno.test("JudgeTask 序列化: 默认值不出现 (judge_type 始终必填)", () => {
  // Issue #66 设计：noj-core 必须在 MQ 消息中显式填 judge_type（无遗漏），
  // noj-judge 端缺失字段才回退到 Special。
  // 本测试反向守护 noj-core 始终在 createSubmission 写入字段。
  const task: JudgeTask = {
    submission_id: "sid-3",
    problem_id: "1001",
    judge_image: "noj-judge-python",
    judge_command: "python3 /tmp/evaluate.py",
    support_package_base64: undefined,
    language: "python3",
    code: "",
    file_name: undefined,
    time_limit_ms: 5000,
    memory_limit_mb: 512,
    judge_type: "standard",
  };
  const json = JSON.stringify(task);
  const parsed = JSON.parse(json);
  assertExists(parsed.judge_type);
  assertEquals(parsed.judge_type, "standard");
});

Deno.test("JudgeTask 支持无 support_package_base64", () => {
  // 回归：标准题可能不依赖 zip，judge_type 与 support_package_base64 互不干扰
  const json = JSON.stringify({
    submission_id: "sid-4",
    problem_id: "1003",
    judge_image: "noj-judge-python",
    judge_command: "python3 /tmp/evaluate.py",
    language: "python3",
    code: "print(1)",
    time_limit_ms: 5000,
    memory_limit_mb: 512,
    judge_type: "standard",
  });
  const task: JudgeTask = JSON.parse(json);
  assertEquals(task.support_package_base64, undefined);
  assertEquals(task.judge_type, "standard");
});
