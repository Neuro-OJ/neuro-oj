import { UsageError } from "../../util/args.ts";

/** 与 Worker 分池默认容量一致；可用于混合或专用 Worker。 */
export const SCHEDULING_ENV_DEFAULTS: Readonly<Record<string, string>> = {
  JUDGE_RESOURCE_GROUP: "",
  JUDGE_RESOURCE_POOLS: "oi-wasm,oi-native,ai",
  JUDGE_WASM_TASK_CONCURRENCY: "4",
  JUDGE_NATIVE_TASK_CONCURRENCY: "2",
  JUDGE_AI_TASK_CONCURRENCY: "2",
  JUDGE_WASM_COMPILE_CONCURRENCY: "2",
  JUDGE_WASM_CASE_CONCURRENCY: "16",
  JUDGE_RESOURCE_MEMORY_MB: "auto",
};

/** 校验启动时冻结的调度配置；旧共享并发参数不再限制新资源池。 */
export function assertSchedulingEnv(env: Record<string, string>): void {
  for (const [key, fallback] of Object.entries(SCHEDULING_ENV_DEFAULTS)) {
    const value = env[key] ?? fallback;
    if (
      key.endsWith("CONCURRENCY") &&
      (!/^[1-9][0-9]*$/.test(value) || Number(value) > 1024)
    ) {
      throw new UsageError(`${key} 必须为 1～1024 的正整数`);
    }
    if (
      key === "JUDGE_RESOURCE_MEMORY_MB" && value !== "auto" &&
      !/^[1-9][0-9]*$/.test(value)
    ) {
      throw new UsageError(`${key} 必须为 auto 或正整数`);
    }
    if (
      key === "JUDGE_RESOURCE_GROUP" && value &&
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)
    ) {
      throw new UsageError(`${key} 包含非法字符`);
    }
    if (key === "JUDGE_RESOURCE_POOLS") {
      const pools = value.split(",").map((pool) => pool.trim());
      if (
        new Set(pools).size !== pools.length ||
        pools.some((pool) => !["oi-wasm", "oi-native", "ai"].includes(pool))
      ) {
        throw new UsageError(`${key} 只能包含不重复的 oi-wasm、oi-native、ai`);
      }
    }
  }
}
