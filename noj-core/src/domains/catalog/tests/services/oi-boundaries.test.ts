import { assertThrows } from "jsr:@std/assert@^1";
import { validateOiRuntimeConfig } from "../../types/runtime-config.ts";
const base = () => ({
  backend: "native",
  languages: ["c"],
  time_limit_ms: 1000,
  memory_limit_mb: 256,
  checker: { type: "default" },
  subtasks: [{
    id: "all",
    score: 100,
    cases: [{ input: "1.in", output: "1.out" }],
  }],
});
Deno.test("OI: 拒绝超过512MiB与总时限60秒", () => {
  assertThrows(() =>
    validateOiRuntimeConfig({ ...base(), memory_limit_mb: 513 })
  );
  assertThrows(() =>
    validateOiRuntimeConfig({ ...base(), time_limit_ms: 60001 })
  );
});
Deno.test("OI: 限制测试点100个且检查继承后的资源", () => {
  const config = base();
  config.subtasks[0].cases = Array.from(
    { length: 101 },
    (_, i) => ({ input: `${i}.in`, output: `${i}.out` }),
  );
  assertThrows(() => validateOiRuntimeConfig(config));
  assertThrows(() =>
    validateOiRuntimeConfig({
      ...base(),
      subtasks: [{
        id: "all",
        score: 100,
        memory_limit_mb: 513,
        cases: [{ input: "1.in", output: "1.out" }],
      }],
    })
  );
});
Deno.test("OI: 用户不能注入成本表或windows绝对路径", () => {
  assertThrows(() => validateOiRuntimeConfig({ ...base(), cost_profile: {} }));
  assertThrows(() =>
    validateOiRuntimeConfig({
      ...base(),
      subtasks: [{
        id: "all",
        score: 100,
        cases: [{ input: "C:/secret", output: "1.out" }],
      }],
    })
  );
});
