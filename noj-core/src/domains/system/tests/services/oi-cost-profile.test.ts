import { assertEquals, assertRejects } from "jsr:@std/assert@^1";
import {
  canonicalProfileJson,
  validateActivatableOiCostProfile,
} from "../../services/oi-cost-profile.ts";

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function validProfile() {
  const withoutHash = {
    schema_version: 1,
    runtime_version: "wasmtime-49",
    costs: { default: 1 },
    variable_costs: { memory_copy_per_byte: 2 },
    io_fuel_per_byte: 1,
    fuel_per_ms: 100,
    benchmark: "test",
    validation: {
      p95_relative_error: 0.1,
      category_median_relative_error: 0.1,
      holdout_samples: 3,
      measurement_verified: true,
    },
  };
  return {
    ...withoutHash,
    hash: await sha256(canonicalProfileJson(withoutHash)),
  };
}

Deno.test("OI 成本表：通过留出集和摘要校验", async () => {
  const profile = await validateActivatableOiCostProfile(await validProfile());
  assertEquals(profile.runtime_version, "wasmtime-49");
});

Deno.test("OI 成本表：摘要篡改或误差超阈值会被拒绝", async () => {
  const profile = await validProfile();
  await assertRejects(
    () => validateActivatableOiCostProfile({ ...profile, fuel_per_ms: 101 }),
    Error,
    "摘要",
  );
  await assertRejects(
    () =>
      validateActivatableOiCostProfile({
        ...profile,
        validation: { ...profile.validation, p95_relative_error: 0.26 },
      }),
    Error,
    "留出集",
  );
});

Deno.test("OI 成本表：拒绝运行时不支持的版本和成本字段", async () => {
  const profile = await validProfile();
  for (
    const patch of [
      { runtime_version: "wasmtime-48" },
      { costs: { default: 2 } },
      { variable_costs: { add: 2 } },
    ]
  ) {
    await assertRejects(
      () => validateActivatableOiCostProfile({ ...profile, ...patch }),
      Error,
      "结构",
    );
  }
});
