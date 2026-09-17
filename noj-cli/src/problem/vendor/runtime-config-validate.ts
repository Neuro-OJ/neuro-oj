// ⚠️ **本文件是 noj-core 的刻意副本**（issue #514 决策：noj-cli 不依赖主仓库导入映射）。
// 原始路径：noj-core/src/domains/catalog/services/problems/problems-types.ts
// 修改时必须同步两处，并运行 noj-cli/src/problem/contract_test.ts（共享 fixture 契约测试）。
/**
 * runtime_config 结构校验（**vendored 副本**，见 problem-bundle.ts 顶部说明）。
 *
 * 本文件是 `noj-core/src/domains/catalog/services/problems/problems-types.ts` 中
 * `validateRuntimeConfig` 的**刻意副本**：`noj-cli` 需在**离线、无 DB** 的前提下
 * 校验题目包，而原函数所在的模块经由域门面间接依赖数据库服务。
 *
 * ⚠️ 修改本文件必须同步修改上述原始路径，并运行
 * `deno test -A noj-cli/src/problem/contract_test.ts`（共享 fixture 契约测试）。
 */
import { BadRequestError } from "./errors.ts";
import type { RuntimeConfig } from "./runtime-config.ts";

/**
 * 校验 runtime_config 结构（不涉及白名单 / kind，调用方负责）。
 *
 * @throws {BadRequestError} 缺字段、类型错、值越界
 */
export function validateRuntimeConfig(rc: RuntimeConfig): void {
  if (!rc.evaluator || typeof rc.evaluator !== "object") {
    throw new BadRequestError("runtime_config.evaluator 必须是对象");
  }
  if (!rc.solution || typeof rc.solution !== "object") {
    throw new BadRequestError("runtime_config.solution 必须是对象");
  }

  const evaluator = rc.evaluator;
  if (typeof evaluator.image !== "string" || !evaluator.image.trim()) {
    throw new BadRequestError(
      "runtime_config.evaluator.image 必须是非空字符串",
    );
  }
  if (typeof evaluator.command !== "string" || !evaluator.command.trim()) {
    throw new BadRequestError(
      "runtime_config.evaluator.command 必须是非空字符串",
    );
  }
  if (
    typeof evaluator.time_limit_ms !== "number" ||
    evaluator.time_limit_ms <= 0
  ) {
    throw new BadRequestError(
      "runtime_config.evaluator.time_limit_ms 必须为正整数",
    );
  }
  if (
    typeof evaluator.memory_limit_mb !== "number" ||
    evaluator.memory_limit_mb <= 0
  ) {
    throw new BadRequestError(
      "runtime_config.evaluator.memory_limit_mb 必须为正整数",
    );
  }

  if (evaluator.network !== undefined && evaluator.network !== null) {
    if (
      typeof evaluator.network !== "object" || Array.isArray(evaluator.network)
    ) {
      throw new BadRequestError(
        "runtime_config.evaluator.network 必须是对象",
      );
    }
    const network = evaluator.network as { enabled?: unknown };
    if (typeof network.enabled !== "boolean") {
      throw new BadRequestError(
        "runtime_config.evaluator.network.enabled 必须是布尔值",
      );
    }
  }

  const solution = rc.solution;
  if (typeof solution.image !== "string" || !solution.image.trim()) {
    throw new BadRequestError("runtime_config.solution.image 必须是非空字符串");
  }
  if (
    typeof solution.call_timeout_ms !== "number" ||
    solution.call_timeout_ms <= 0
  ) {
    throw new BadRequestError(
      "runtime_config.solution.call_timeout_ms 必须为正整数",
    );
  }
  if (
    typeof solution.memory_limit_mb !== "number" ||
    solution.memory_limit_mb <= 0
  ) {
    throw new BadRequestError(
      "runtime_config.solution.memory_limit_mb 必须为正整数",
    );
  }
}
