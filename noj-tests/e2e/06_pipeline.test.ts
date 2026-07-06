/**
 * 全链路评测管道 E2E 测试。
 *
 * 需要 noj-judge-worker 在运行（完整 Docker 沙箱评测栈），否则跳过。
 */

import {
  BASE_URL,
  CODE_SAMPLES,
  isE2E,
  pollSubmission,
  registerUser,
  submitCode,
  waitForServer,
} from "./helper.ts";

const skip = !isE2E;
let token = "";
const PROBLEM_ID = "1001";

// 检测 judge worker 是否可用（提交后 5s 内状态变为 judging 而非 pending）
async function isJudgeAvailable(): Promise<boolean> {
  try {
    const ts = Date.now().toString(36);
    const t = await registerUser(
      "pipe_check_" + ts,
      "pipe_check_" + ts + "@test.com",
      "Test12345679",
    );
    const id = await submitCode(t, PROBLEM_ID, "print(1)");
    // 等一小段时间看状态是否推进
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${BASE_URL}/api/v1/submissions/${id}`, {
      headers: { Authorization: "Bearer " + t },
    });
    const data = await res.json();
    const status = (data as { data?: { status?: string } })?.data?.status || "";
    return status === "judging" || status === "finished";
  } catch {
    return false;
  }
}

let judgeOk = false;

Deno.test({
  name: "[e2e/pipeline] Setup",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    await waitForServer();
    const ts = Date.now().toString(36);
    token = await registerUser(
      "pipe_user_" + ts,
      "pipe_user_" + ts + "@test.com",
      "Test12345679",
    );
    console.log("  → 用户已注册");
    judgeOk = await isJudgeAvailable();
    if (!judgeOk) console.log("  ⚠ judge worker 不可用，管道测试将跳过");
  },
});

Deno.test({
  name: "[e2e/pipeline] 1/5 Accepted",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !judgeOk) return;
    const id = await submitCode(token, PROBLEM_ID, CODE_SAMPLES.accepted);
    console.log("  → 提交 ID: " + id.slice(0, 8));
    const result = await pollSubmission(token, id);
    console.log("  → " + result.verdict + " (" + result.score + "分)");
    if (result.verdict !== "Accepted") {
      throw new Error("期望 Accepted, 实际 " + result.verdict);
    }
  },
});

Deno.test({
  name: "[e2e/pipeline] 2/5 Wrong Answer",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !judgeOk) return;
    const id = await submitCode(token, PROBLEM_ID, CODE_SAMPLES.wrongAnswer);
    const result = await pollSubmission(token, id);
    if (result.verdict !== "WrongAnswer") {
      throw new Error("期望 WrongAnswer, 实际 " + result.verdict);
    }
  },
});

Deno.test({
  name: "[e2e/pipeline] 3/5 TLE",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !judgeOk) return;
    const id = await submitCode(
      token,
      PROBLEM_ID,
      CODE_SAMPLES.timeLimitExceeded,
    );
    const result = await pollSubmission(token, id, 10, 2000);
    if (result.verdict !== "TimeLimitExceeded") {
      throw new Error("期望 TLE, 实际 " + result.verdict);
    }
  },
});

Deno.test({
  name: "[e2e/pipeline] 4/5 MQ 可靠性",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !judgeOk) return;
    const id = await submitCode(token, PROBLEM_ID, CODE_SAMPLES.accepted);
    const result = await pollSubmission(token, id);
    if (result.status !== "finished") throw new Error("状态非 finished");
    if (result.score <= 0) throw new Error("分数应 >0");
  },
});

Deno.test({
  name: "[e2e/pipeline] 5/5 无效消息容错",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E) return;
    if (!judgeOk) return;
    try {
      const cmd = new Deno.Command("docker", {
        args: [
          "exec",
          "noj-e2e-redis",
          "redis-cli",
          "RPUSH",
          "noj:judge:results",
          "{invalid json}",
        ],
      });
      const { success } = await cmd.output();
      if (!success) {
        console.log("  ⚠ docker exec 失败，跳过");
        return;
      }
    } catch {
      console.log("  ⚠ docker exec 异常，跳过");
      return;
    }
    const id = await submitCode(token, PROBLEM_ID, CODE_SAMPLES.accepted);
    const result = await pollSubmission(token, id);
    if (result.status !== "finished") throw new Error("非法消息后提交未完成");
  },
});

Deno.test({
  name: "[e2e/pipeline] 6/8 Memory Limit Exceeded",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !judgeOk) return;
    const id = await submitCode(
      token,
      PROBLEM_ID,
      CODE_SAMPLES.memoryLimitExceeded,
    );
    const result = await pollSubmission(token, id, 15, 2000);
    if (result.verdict !== "MemoryLimitExceeded" && result.verdict !== "RuntimeError") {
      throw new Error("期望 MLE 或 RuntimeError, 实际 " + result.verdict);
    }
    console.log("  → " + result.verdict);
  },
});

Deno.test({
  name: "[e2e/pipeline] 7/8 Runtime Error",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !judgeOk) return;
    const id = await submitCode(
      token,
      PROBLEM_ID,
      CODE_SAMPLES.runtimeError,
    );
    const result = await pollSubmission(token, id, 15, 2000);
    if (result.verdict !== "RuntimeError") {
      throw new Error("期望 RuntimeError, 实际 " + result.verdict);
    }
  },
});

Deno.test({
  name: "[e2e/pipeline] 8/8 Syntax Error",
  ignore: skip,
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    if (!isE2E || !judgeOk) return;
    const id = await submitCode(
      token,
      PROBLEM_ID,
      CODE_SAMPLES.syntaxError,
    );
    const result = await pollSubmission(token, id, 15, 2000);
    if (result.verdict !== "CompileError" && result.verdict !== "RuntimeError") {
      throw new Error("期望 CompileError/RuntimeError, 实际 " + result.verdict);
    }
  },
});
