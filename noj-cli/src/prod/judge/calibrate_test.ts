import {
  assertAlmostEquals,
  assertEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import { fitOiCostProfile, parseCalibrationInput } from "./calibrate.ts";

const input = parseCalibrationInput({
  runtime_version: "wasmtime-49",
  samples: [
    {
      category: "integer",
      features: { base_fuel: 10000 },
      observed_time_ms: 10,
    },
    {
      category: "integer",
      features: { base_fuel: 20000 },
      observed_time_ms: 20,
    },
    {
      category: "integer",
      features: {
        base_fuel: 1000,
        memory_copy_per_byte: 10000,
        memory_grow_per_page: 2000,
      },
      observed_time_ms: 25,
    },
    {
      category: "integer",
      features: {
        base_fuel: 1000,
        memory_copy_per_byte: 20000,
        memory_grow_per_page: 2000,
      },
      observed_time_ms: 45,
    },
    {
      category: "memory",
      features: {
        base_fuel: 1000,
        memory_copy_per_byte: 5000,
        memory_grow_per_page: 10000,
      },
      observed_time_ms: 31,
    },
    {
      category: "memory",
      features: {
        base_fuel: 1000,
        memory_copy_per_byte: 5000,
        memory_grow_per_page: 20000,
      },
      observed_time_ms: 51,
    },
  ],
  holdout_samples: [
    {
      category: "integer",
      features: {
        base_fuel: 1000,
        memory_copy_per_byte: 15000,
        memory_grow_per_page: 2000,
      },
      observed_time_ms: 35,
    },
    {
      category: "memory",
      features: {
        base_fuel: 1000,
        memory_copy_per_byte: 5000,
        memory_grow_per_page: 15000,
      },
      observed_time_ms: 41,
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

Deno.test("OI 校准：普通指令与变量成本使用运行时同一时间尺度", async () => {
  const profile = await fitOiCostProfile(input, { measurementVerified: true });
  assertAlmostEquals(profile.fuel_per_ms, 1000, 0.01);
  for (const sample of input.holdout_samples) {
    const fuel = Object.entries(sample.features).reduce(
      (sum, [key, count]) =>
        sum +
        count * (key === "base_fuel" ? 1 : profile.variable_costs[key] ?? 1),
      0,
    );
    assertAlmostEquals(
      fuel / profile.fuel_per_ms,
      sample.observed_time_ms,
      0.01,
    );
  }
  assertThrows(
    () =>
      parseCalibrationInput({
        ...input,
        samples: input.samples.map((s) => ({ ...s, features: { add: 10 } })),
      }),
    Error,
    "未支持",
  );
  await assertRejects(
    () =>
      fitOiCostProfile({
        ...input,
        holdout_samples: input.holdout_samples.map((s) => ({
          ...s,
          observed_time_ms: 1000,
        })),
      }, { measurementVerified: true }),
    Error,
    "留出集",
  );
});
