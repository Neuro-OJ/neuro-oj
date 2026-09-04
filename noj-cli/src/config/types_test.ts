import { assertEquals } from "@std/assert";
import { type DeployState, SCHEMA_VERSION } from "./types.ts";

Deno.test("SCHEMA_VERSION 为 1", () => {
  assertEquals(SCHEMA_VERSION, 1);
});

Deno.test("DeployState 允许的取值", () => {
  const states: DeployState[] = [
    "uninitialized",
    "stopped",
    "running",
    "partial",
    "error",
  ];
  assertEquals(states.length, 5);
});
