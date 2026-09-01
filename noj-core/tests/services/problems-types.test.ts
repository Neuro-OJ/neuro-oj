/**
 * problems-types 服务层单元测试 —— runtime_config 结构校验。
 *
 * 纯函数测试，不依赖数据库（validateRuntimeConfig 为同步纯函数）。
 */
import { assertThrows } from "jsr:@std/assert@^1";
import { validateRuntimeConfig } from "../../src/domains/catalog/index.ts";
import type { RuntimeConfig } from "../../src/types/problems.ts";

function validRuntimeConfig(): RuntimeConfig {
  return {
    evaluator: {
      image: "noj-evaluator-python",
      command: "python3 /workspace/evaluate.py",
      time_limit_ms: 5000,
      memory_limit_mb: 512,
    },
    solution: {
      image: "noj-solution-python",
      call_timeout_ms: 2000,
      memory_limit_mb: 256,
    },
  };
}

Deno.test({
  name: "validateRuntimeConfig: network 缺省合法（向后兼容）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    const rc = validRuntimeConfig();
    validateRuntimeConfig(rc); // 不应抛错
  },
});

Deno.test({
  name: "validateRuntimeConfig: network.enabled=true 合法",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    const rc = validRuntimeConfig();
    rc.evaluator.network = { enabled: true };
    validateRuntimeConfig(rc); // 不应抛错
  },
});

Deno.test({
  name: "validateRuntimeConfig: network.enabled=false 合法",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    const rc = validRuntimeConfig();
    rc.evaluator.network = { enabled: false };
    validateRuntimeConfig(rc); // 不应抛错
  },
});

Deno.test({
  name: "validateRuntimeConfig: network.enabled 非布尔被拒",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    const rc = validRuntimeConfig();
    rc.evaluator.network = { enabled: "true" as unknown as boolean };
    assertThrows(
      () => validateRuntimeConfig(rc),
      Error,
      "runtime_config.evaluator.network.enabled 必须是布尔值",
    );
  },
});

Deno.test({
  name: "validateRuntimeConfig: network 非对象被拒",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    const rc = validRuntimeConfig();
    rc.evaluator.network = "enabled" as unknown as { enabled: boolean };
    assertThrows(
      () => validateRuntimeConfig(rc),
      Error,
      "runtime_config.evaluator.network 必须是对象",
    );
  },
});

Deno.test({
  name: "validateRuntimeConfig: network 为 null 视为缺省（合法）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    const rc = validRuntimeConfig();
    rc.evaluator.network = null as unknown as { enabled: boolean };
    validateRuntimeConfig(rc); // 不应抛错
  },
});
