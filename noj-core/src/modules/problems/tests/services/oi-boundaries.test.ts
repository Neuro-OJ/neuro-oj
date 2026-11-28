import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import {
  getJudgeBackend,
  validateOiRuntimeConfig,
} from "../../types/runtime-config.ts";
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
Deno.test("OI: 公开后端标识区分原生（含存量 WASM 兼容）、双容器与客观题", () => {
  assertEquals(getJudgeBackend("oi", base()), "oi-native");
  assertEquals(
    getJudgeBackend("oi", { ...base(), backend: "wasm" }),
    "oi-native",
  );
  assertEquals(getJudgeBackend("dual", null), "dual");
  assertEquals(getJudgeBackend(undefined, null), "dual");
  assertEquals(getJudgeBackend("oi", null), null);
  assertEquals(getJudgeBackend("dual", null, true), null);
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

Deno.test("OI: 新配置仅允许 native 后端，总时限按测试点与子任务覆盖累计不超过 60 秒", () => {
  assertThrows(() =>
    validateOiRuntimeConfig({
      ...base(),
      backend: "wasm" as never,
    })
  );
  const config = {
    ...base(),
    time_limit_ms: 1,
    subtasks: [{
      id: "all",
      score: 100,
      time_limit_ms: 30000,
      cases: [
        { input: "1.in", output: "1.out", time_limit_ms: 30000 },
        { input: "2.in", output: "2.out" },
      ],
    }],
  };
  validateOiRuntimeConfig(config);
  assertThrows(() =>
    validateOiRuntimeConfig({
      ...config,
      subtasks: [{ ...config.subtasks[0], time_limit_ms: 30001 }],
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
Deno.test("OI: checker 额外文件不能泄露到测试数据或用户资源路径", () => {
  assertThrows(() =>
    validateOiRuntimeConfig({
      ...base(),
      checker_extra_files: ["1.in"],
    })
  );
  assertThrows(() =>
    validateOiRuntimeConfig({
      ...base(),
      checker_extra_files: ["helper.h"],
      subtasks: [{
        id: "all",
        score: 100,
        cases: [{ input: "1.in", output: "helper.h" }],
      }],
    })
  );
});

Deno.test("OI: 测试点、checker 与 filename 生成文件不能互相覆盖", () => {
  assertThrows(() =>
    validateOiRuntimeConfig({
      ...base(),
      subtasks: [{
        id: "all",
        score: 100,
        cases: [
          { input: "1.in", output: "1.out" },
          { input: "2.in", output: "1.out" },
        ],
      }],
    })
  );
  assertThrows(() => validateOiRuntimeConfig({ ...base(), filename: "1" }));
  assertThrows(() =>
    validateOiRuntimeConfig({
      ...base(),
      checker: { type: "testlib", path: "1.out" },
    })
  );
  assertThrows(() =>
    validateOiRuntimeConfig({
      ...base(),
      filename: "answer",
      user_extra_files: ["answer.out"],
    })
  );
});
