import {
  getRequestId,
  runWithRequestContext,
} from "../../../src/shared/observability/context.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

Deno.test("context: runWithRequestContext 内可读取 requestId", () => {
  let inside: string | undefined;
  runWithRequestContext("req-1", () => {
    inside = getRequestId();
  });
  assert(inside === "req-1", "上下文内应读到 req-1");
});

Deno.test("context: 上下文外 getRequestId 返回 undefined", () => {
  assert(getRequestId() === undefined, "上下文外应为 undefined");
});
