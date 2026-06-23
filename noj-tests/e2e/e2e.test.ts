/**
 * noj-tests 全链路 E2E 测试。
 *
 * 验证完整提交流程：提交 → MQ → Judge → 结果 → 持久化。
 *
 * 前置条件：评测栈已运行（由 CI 或 docker compose up -d 启动）
 *   NOJ_RUN_E2E=1 deno task test:e2e
 *
 * 测试流程：
 *   1. 等待 API 就绪
 *   2. 注册用户
 *   3. 执行 5 个测试用例
 * （容器由 CI 或调用方管理，测试不负责启停）
 */

import {
  CODE_SAMPLES,
  isE2E,
  pollSubmission,
  registerUser,
  submitCode,
  waitForServer,
} from "./helper.ts";

// ── 门控 ──────────────────────────────────────────

Deno.test({
  name: "[e2e] 门控：NOJ_RUN_E2E 未设置时跳过",
  ignore: isE2E,
  fn: () => {
    console.log("  → NOJ_RUN_E2E 未设置，跳过 E2E 测试");
    console.log("  → 设置 NOJ_RUN_E2E=1 启用");
  },
});

// ── 设置 ──────────────────────────────────────────

let token = "";
const TEST_USER = `e2e_user_${Date.now()}`;
const PROBLEM_ID = "1001";

Deno.test({
  name: "[e2e] Setup: 等待 API 就绪 + 注册用户",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    await waitForServer();
    token = await registerUser(
      TEST_USER,
      `${TEST_USER}@test.com`,
      "test123456",
    );
    console.log(`  → 测试用户: ${TEST_USER}`);
  },
});

// ── 测试用例 ──────────────────────────────────────

Deno.test({
  name: "[e2e] 1/5 Accepted: 正确代码应获得 Accepted",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const id = await submitCode(token, PROBLEM_ID, CODE_SAMPLES.accepted);
    console.log(`  → 提交 ID: ${id}`);
    const result = await pollSubmission(token, id);
    console.log(`  → 结果: ${result.verdict} (${result.score}分)`);
    if (result.verdict !== "Accepted") {
      throw new Error(`期望 Accepted，实际 ${result.verdict}`);
    }
    console.log("  ✓ Accepted 验证通过");
  },
});

Deno.test({
  name: "[e2e] 2/5 Wrong Answer: 错误代码应获得 Wrong Answer",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const id = await submitCode(token, PROBLEM_ID, CODE_SAMPLES.wrongAnswer);
    console.log(`  → 提交 ID: ${id}`);
    const result = await pollSubmission(token, id);
    console.log(`  → 结果: ${result.verdict} (${result.score}分)`);
    if (result.verdict !== "WrongAnswer") {
      throw new Error(`期望 WrongAnswer，实际 ${result.verdict}`);
    }
    console.log("  ✓ Wrong Answer 验证通过");
  },
});

Deno.test({
  name: "[e2e] 3/5 TLE: 死循环代码应获得 Time Limit Exceeded",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    const id = await submitCode(
      token,
      PROBLEM_ID,
      CODE_SAMPLES.timeLimitExceeded,
    );
    console.log(`  → 提交 ID: ${id}`);
    // TLE 需要等待超时 kill，给 20s 超时
    const result = await pollSubmission(token, id, 10, 2000);
    console.log(`  → 结果: ${result.verdict}`);
    if (result.verdict !== "TimeLimitExceeded") {
      throw new Error(`期望 TimeLimitExceeded，实际 ${result.verdict}`);
    }
    console.log("  ✓ TLE 验证通过");
  },
});

Deno.test({
  name: "[e2e] 4/5 MQ 可靠性: 结果被正确持久化",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;

    const id = await submitCode(token, PROBLEM_ID, CODE_SAMPLES.accepted);
    console.log(`  → 提交 ID: ${id}`);
    const result = await pollSubmission(token, id);
    console.log(`  → 结果: ${result.verdict} (${result.score}分)`);

    if (result.status !== "finished") {
      throw new Error(`期望 finished，实际 ${result.status}`);
    }
    if (result.score <= 0) {
      throw new Error(`期望分数 >0，实际 ${result.score}`);
    }
    console.log("  ✓ MQ 可靠性验证通过");
  },
});

Deno.test({
  name: "[e2e] 5/5 无效消息容错: 非法 JSON 不阻塞后续消费",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;

    console.log("  → 向结果队列注入非法 JSON...");
    try {
      const cmd = new Deno.Command("docker", {
        args: [
          "exec", "noj-e2e-redis",
          "redis-cli",
          "RPUSH", "noj:judge:results", "{invalid json}",
        ],
      });
      const { success } = await cmd.output();
      if (!success) {
        console.log("  ⚠ docker exec 注入失败，跳过此测试");
        return;
      }
      console.log("  → 非法消息已注入");
    } catch (e) {
      console.warn(`  ⚠ docker exec 注入失败: ${e}`);
      return;
    }

    const id = await submitCode(token, PROBLEM_ID, CODE_SAMPLES.accepted);
    console.log(`  → 合法提交 ID: ${id}`);
    const result = await pollSubmission(token, id);
    console.log(`  → 结果: ${result.verdict} (${result.score}分)`);

    if (result.status !== "finished") {
      throw new Error(`非法消息后合法提交未完成: ${result.status}`);
    }
    console.log("  ✓ 无效消息容错验证通过");
  },
});
