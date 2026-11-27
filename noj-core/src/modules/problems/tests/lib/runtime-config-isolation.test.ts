import { assertThrows } from "jsr:@std/assert@^1";
import { BadRequestError } from "../../../../shared/base/errors.ts";
import { validateRuntimeConfig } from "../../services/problems/problems-types.ts";
import { assertDraftRuntimeConfigShape } from "../../services/versioning/content-security.ts";
import type { RuntimeConfig } from "../../types/runtime-config.ts";

function baseConfig(
  isolationMode?: unknown,
): RuntimeConfig {
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
      memory_limit_mb: 512,
      ...(isolationMode !== undefined
        ? { isolation_mode: isolationMode as never }
        : {}),
    },
  };
}

Deno.test("runtime-config: solution.isolation_mode 允许缺省、shared 与 fork_per_call", () => {
  for (const mode of [undefined, "shared", "fork_per_call"] as const) {
    const rc = baseConfig(mode);
    validateRuntimeConfig(rc);
    assertDraftRuntimeConfigShape(rc);
  }
});

Deno.test("runtime-config: solution.isolation_mode 非法值应被拒绝", () => {
  const bad = baseConfig("process_pool");
  assertThrows(() => validateRuntimeConfig(bad), BadRequestError);
  assertThrows(() => assertDraftRuntimeConfigShape(bad), BadRequestError);
});
