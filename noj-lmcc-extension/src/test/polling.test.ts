import assert from "node:assert/strict";
import test from "node:test";
import { pollSubmission, PollTimeoutError } from "../polling";
import type { SubmissionDetail, SubmissionStatus } from "../types";

function detail(status: SubmissionStatus): SubmissionDetail {
  return {
    id: "s1",
    status,
    problem_id: "p1",
    file_name: "submission.py",
    result:
      status === "finished"
        ? {
            status: "finished",
            score: 10000,
            output: "ok",
            output_truncated: false,
            time_ms: 20,
            memory_kb: 1024,
            details: null,
          }
        : null,
    queue_position: null,
    queue_length: null,
  };
}

test("pollSubmission 等待到终态并报告每次状态", async () => {
  const statuses: SubmissionStatus[] = ["pending", "judging", "finished"];
  const updates: SubmissionStatus[] = [];
  const result = await pollSubmission(
    async () => detail(statuses.shift() ?? "finished"),
    {
      intervalMs: 1,
      timeoutMs: 1000,
      sleep: async () => undefined,
      onUpdate: (current) => updates.push(current.status),
    },
  );

  assert.equal(result.status, "finished");
  assert.deepEqual(updates, ["pending", "judging", "finished"]);
});

test("pollSubmission 支持取消", async () => {
  await assert.rejects(
    () =>
      pollSubmission(async () => detail("judging"), {
        intervalMs: 1,
        timeoutMs: 1000,
        isCancelled: () => true,
        sleep: async () => undefined,
      }),
    /已取消/,
  );
});

test("pollSubmission 超时后抛出明确错误", async () => {
  const realNow = Date.now;
  let now = 0;
  Date.now = () => now;
  try {
    await assert.rejects(
      () =>
        pollSubmission(async () => detail("judging"), {
          intervalMs: 10,
          timeoutMs: 5,
          sleep: async () => {
            now += 10;
          },
        }),
      PollTimeoutError,
    );
  } finally {
    Date.now = realNow;
  }
});
