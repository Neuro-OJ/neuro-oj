// 类型安全辅助函数测试。
import {
  assertNever,
  isTerminalSubmissionStatus,
  type SubmissionStatus,
} from "../src/domains/submission/index.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("types: 终态判定", () => {
  const terminal: SubmissionStatus[] = ["finished", "error"];
  const nonTerminal: SubmissionStatus[] = ["pending", "judging"];
  for (const s of terminal) {
    assert(isTerminalSubmissionStatus(s), `${s} 应为终态`);
  }
  for (const s of nonTerminal) {
    assert(!isTerminalSubmissionStatus(s), `${s} 不应为终态`);
  }
});

Deno.test("types: assertNever 对不可达值抛错", () => {
  try {
    assertNever("unexpected" as never);
  } catch {
    return;
  }
  throw new Error("assertNever 应抛错");
});
