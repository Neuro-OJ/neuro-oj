/**
 * problems-types 服务层单元测试 —— runtime_config 结构校验。
 *
 * 纯函数测试，不依赖数据库（validateRuntimeConfig 为同步纯函数）。
 */
import { assertThrows } from "jsr:@std/assert@^1";
import { validateRuntimeConfig } from "../../index.ts";
import type { RuntimeConfig } from "../../index.ts";
import { BadRequestError } from "../../../../shared/base/errors.ts";

/** 仅含 evaluator 的 runtime_config（prediction 模式合法形态，省略 solution）。 */
function evaluatorOnlyRuntimeConfig(): RuntimeConfig {
  return {
    evaluator: {
      image: "noj-evaluator-python",
      command: "python3 /workspace/evaluate.py",
      time_limit_ms: 5000,
      memory_limit_mb: 256,
    },
  };
}

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

Deno.test({
  name:
    "validateRuntimeConfig: prediction 模式允许省略 runtime_config.solution",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    validateRuntimeConfig(evaluatorOnlyRuntimeConfig(), "prediction");
  },
});

Deno.test({
  name: "validateRuntimeConfig: artifact 模式仍要求 runtime_config.solution",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    // artifact 与 code 同属"需要 Solution 容器"的模式，此处省略 solution
    // 仍应被拒（数据完整性在创建期强制，不推迟到提交期 500）。
    assertThrows(
      () => validateRuntimeConfig(evaluatorOnlyRuntimeConfig(), "artifact"),
      BadRequestError,
      "runtime_config.solution 必须是对象",
    );
  },
});

Deno.test({
  name: "validateRuntimeConfig: code 模式仍要求 runtime_config.solution",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    assertThrows(
      () => validateRuntimeConfig(evaluatorOnlyRuntimeConfig(), "code"),
      BadRequestError,
      "runtime_config.solution 必须是对象",
    );
  },
});

Deno.test({
  name: "validateRuntimeConfig: 缺省模式（未传参）仍要求 solution（向后兼容）",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    assertThrows(
      () => validateRuntimeConfig(evaluatorOnlyRuntimeConfig()),
      BadRequestError,
      "runtime_config.solution 必须是对象",
    );
  },
});

Deno.test({
  name: "validateRuntimeConfig: prediction 下显式提供 solution 仍照常校验",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    const rc = validRuntimeConfig();
    rc.solution!.call_timeout_ms = 0;
    assertThrows(
      () => validateRuntimeConfig(rc, "prediction"),
      BadRequestError,
      "runtime_config.solution.call_timeout_ms 必须为正整数",
    );
  },
});

Deno.test({
  name: "validateRuntimeConfig: workspace_size_mb 正整数合法",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    const rc = evaluatorOnlyRuntimeConfig();
    rc.evaluator.workspace_size_mb = 512;
    validateRuntimeConfig(rc, "prediction"); // 不应抛错
  },
});

Deno.test({
  name: "validateRuntimeConfig: workspace_size_mb 非正整数被拒",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: () => {
    const rc = evaluatorOnlyRuntimeConfig();
    rc.evaluator.workspace_size_mb = 0;
    assertThrows(
      () => validateRuntimeConfig(rc, "prediction"),
      BadRequestError,
      "runtime_config.evaluator.workspace_size_mb 必须为正整数",
    );
  },
});
