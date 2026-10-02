import { assertEquals, assertRejects } from "@std/assert";
import { fitOiCostProfile, parseCalibrationInput } from "./calibrate.ts";

const input = parseCalibrationInput({
  runtime_version: "wasmtime-49",
  samples: [
    {
      category: "integer",
      features: { memory_copy_per_byte: 10, memory_grow_per_page: 2 },
      observed_time_ms: 24,
    },
    {
      category: "integer",
      features: { memory_copy_per_byte: 20, memory_grow_per_page: 2 },
      observed_time_ms: 44,
    },
    {
      category: "memory",
      features: { memory_copy_per_byte: 5, memory_grow_per_page: 10 },
      observed_time_ms: 30,
    },
    {
      category: "memory",
      features: { memory_copy_per_byte: 5, memory_grow_per_page: 20 },
      observed_time_ms: 50,
    },
  ],
  holdout_samples: [
    {
      category: "integer",
      features: { memory_copy_per_byte: 15, memory_grow_per_page: 2 },
      observed_time_ms: 34,
    },
    {
      category: "memory",
      features: { memory_copy_per_byte: 5, memory_grow_per_page: 15 },
      observed_time_ms: 40,
    },
  ],
});

Deno.test("OI 校准要求可信计量标记", async () => {
  await assertRejects(
    () => fitOiCostProfile(input, { measurementVerified: false }),
    Error,
    "measurement-verified",
  );
});

Deno.test("OI 校准输出整数成本、留出误差与摘要", async () => {
  const profile = await fitOiCostProfile(input, {
    measurementVerified: true,
    benchmark: "test-benchmark",
  });
  assertEquals(profile.schema_version, 1);
  assertEquals(profile.runtime_version, "wasmtime-49");
  assertEquals(profile.validation.holdout_samples, 2);
  assertEquals(profile.validation.measurement_verified, true);
  assertEquals(profile.hash.length, 64);
  for (const value of Object.values(profile.variable_costs)) {
    assertEquals(Number.isInteger(value), true);
    assertEquals(value >= 1 && value <= 255, true);
  }
});
