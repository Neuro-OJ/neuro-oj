import { assertEquals } from "jsr:@std/assert@^1";
import {
  getActiveOiCostProfile,
  getOiCostProfileStatus,
} from "../../services/oi-cost-profile.ts";
Deno.test("OI 统一标准：不依赖本机或历史成本表，且不暴露可变引用", async () => {
  const first = await getActiveOiCostProfile();
  assertEquals(first.benchmark, "noj-wasm-v1");
  assertEquals(first.fuel_per_ms, 1_000_000);
  first.fuel_per_ms = 3;
  assertEquals((await getActiveOiCostProfile()).fuel_per_ms, 1_000_000);
  const status = await getOiCostProfileStatus();
  assertEquals(status.standard.id, "noj-wasm-v1");
  assertEquals(status.profile.hash, status.standard.hash);
});
