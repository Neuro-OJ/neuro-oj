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
import type { SubmissionMode } from "./problems.ts";

/**
 * 校验 runtime_config 结构（不涉及白名单 / kind，调用方负责）。
 *
 * `submissionMode` 决定 `solution` 是否必填：
 * - `code` / `artifact`：需要 Solution 容器，`solution` 必填（缺省模式 = code）。
 * - `prediction`：无 Solution 容器，`solution` 可省略；若显式提供仍照常校验。
 *
 * 模式只由显式 `submission_mode` 判定，**不靠字段缺席推断**（缺 solution 的
 * code 题必须在创建期就 400，而不是拖到提交期 500）。
 *
 * @throws {BadRequestError} 缺字段、类型错、值越界
 */
export function validateRuntimeConfig(
  rc: RuntimeConfig,
  submissionMode: SubmissionMode = "code",
): void {
  if (!rc.evaluator || typeof rc.evaluator !== "object") {
    throw new BadRequestError("runtime_config.evaluator 必须是对象");
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

  // evaluator.network（可选，缺省 = 无网）
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

  // prediction 模式允许省略 solution（无 Solution 容器）；code / artifact 必填。
  if (submissionMode !== "prediction" && !rc.solution) {
    throw new BadRequestError("runtime_config.solution 必须是对象");
  }

  if (rc.solution !== undefined && rc.solution !== null) {
    const solution = rc.solution;
    if (typeof solution.image !== "string" || !solution.image.trim()) {
      throw new BadRequestError(
        "runtime_config.solution.image 必须是非空字符串",
      );
    }
    // solution.call_timeout_ms：题目级默认调用超时（必填正整数）；
    // evaluator 的 runner.call(..., timeout_ms) 可按调用覆盖，capability 可经 register_capability(timeout_ms=...) 配置
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

  // evaluator.workspace_size_mb（可选，缺省由 judge 决定；prediction 模式用于
  // /workspace tmpfs 上限）
  if (
    evaluator.workspace_size_mb !== undefined &&
    evaluator.workspace_size_mb !== null
  ) {
    if (
      typeof evaluator.workspace_size_mb !== "number" ||
      !Number.isInteger(evaluator.workspace_size_mb) ||
      evaluator.workspace_size_mb <= 0
    ) {
      throw new BadRequestError(
        "runtime_config.evaluator.workspace_size_mb 必须为正整数",
      );
    }
  }
}
