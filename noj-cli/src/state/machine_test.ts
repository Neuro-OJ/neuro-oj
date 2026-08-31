import { assertEquals } from "@std/assert";
import { transition } from "./machine.ts";

Deno.test("init: 任意状态进入 stopped", () => {
  for (
    const s of [
      "uninitialized",
      "stopped",
      "running",
      "partial",
      "error",
    ] as const
  ) {
    const r = transition(s, "init");
    assertEquals(r.state, "stopped");
    assertEquals(r.changed, true);
  }
});

Deno.test("up: running 是 no-op", () => {
  const r = transition("running", "up");
  assertEquals(r.state, "running");
  assertEquals(r.changed, false);
});

Deno.test("up: stopped/partial/error 进入 running", () => {
  for (const s of ["stopped", "partial", "error"] as const) {
    const r = transition(s, "up");
    assertEquals(r.state, "running");
    assertEquals(r.changed, true);
  }
});

Deno.test("down: stopped 是 no-op", () => {
  const r = transition("stopped", "down");
  assertEquals(r.state, "stopped");
  assertEquals(r.changed, false);
});

Deno.test("down: running/partial/error 进入 stopped", () => {
  for (const s of ["running", "partial", "error"] as const) {
    const r = transition(s, "down");
    assertEquals(r.state, "stopped");
    assertEquals(r.changed, true);
  }
});

Deno.test("restart: 任意状态最终进入 running", () => {
  for (const s of ["stopped", "running", "partial", "error"] as const) {
    const r = transition(s, "restart");
    assertEquals(r.state, "running");
    assertEquals(r.changed, true);
  }
});

Deno.test("reset: 任意状态进入 stopped", () => {
  for (
    const s of [
      "uninitialized",
      "stopped",
      "running",
      "partial",
      "error",
    ] as const
  ) {
    const r = transition(s, "reset");
    assertEquals(r.state, "stopped");
    assertEquals(r.changed, true);
  }
});
