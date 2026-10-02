import { BadRequestError } from "../../../shared/base/errors.ts";

/** 题目评测模式。 */
export type JudgeType = "dual" | "oi";

/**
 * 双容器模式题目运行配置。
 */

/** Evaluator 容器运行时配置。 */
export interface EvaluatorRuntime {
  /** Docker 镜像名（须在 `judge_images` 白名单中且 kind='evaluator'） */
  image: string;
  /** 评测命令，如 `python3 /workspace/evaluate.py` */
  command: string;
  /** Evaluator 容器总时间上限（毫秒） */
  time_limit_ms: number;
  /** Evaluator 容器内存上限（MB） */
  memory_limit_mb: number;
  /** 网络配置（可选，缺省 = 无网；开启后 evaluator 以 bridge 模式联网） */
  network?: {
    enabled: boolean;
  };
}

/** Solution 容器运行时配置。 */
export interface SolutionRuntime {
  /** Docker 镜像名（须在 `judge_images` 白名单中且 kind='solution'） */
  image: string;
  /** 单次 SDK 调用的时间上限（毫秒），作为调用级超时的题目级默认值（runner.call 可传 timeout_ms 覆盖；capability 可经 register_capability 配置）。单次超时不影响 host 进程 */
  call_timeout_ms: number;
  /** Solution 容器内存上限（MB） */
  memory_limit_mb: number;
}

/** 双容器模式的 Runtime 配置（必填）。 */
export interface RuntimeConfig {
  evaluator: EvaluatorRuntime;
  solution: SolutionRuntime;
}

/** OI 测试点文件名以评测包根目录为基准。 */
export interface OiTestCase {
  input: string;
  output: string;
  time_limit_ms?: number;
  memory_limit_mb?: number;
}

/** OI 子任务采用全部通过得分。 */
export interface OiSubtask {
  id: string;
  score: number;
  depends_on?: string[];
  time_limit_ms?: number;
  memory_limit_mb?: number;
  cases: OiTestCase[];
}

/** OI 题在原生与 WASM 执行后端共用的时空限制配置。 */
export interface OiRuntimeConfig {
  backend: "native" | "wasm";
  languages: Array<"c" | "cpp">;
  time_limit_ms: number;
  memory_limit_mb: number;
  checker: { type: "default" | "strict" | "testlib"; path?: string };
  subtasks: OiSubtask[];
}

/** 按题目 judge_type 解释的运行配置。 */
export type ProblemRuntimeConfig = RuntimeConfig | OiRuntimeConfig;

/** 判断一个运行配置是否为 OI 配置。 */
export function isOiRuntimeConfig(
  value: unknown,
): value is OiRuntimeConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return "backend" in record && "subtasks" in record &&
    !("evaluator" in record) && !("solution" in record);
}

/** 题包内引用必须是相对路径，且不能逃逸题包根目录。 */
function isSafeOiPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    !value.includes("\\") && !value.startsWith("/") &&
    !value.includes("\0") &&
    value.split("/").every((segment) =>
      segment !== "" && segment !== "." && segment !== ".."
    );
}

/** 校验 OI 题目运行配置。 */
export function validateOiRuntimeConfig(
  value: unknown,
): asserts value is OiRuntimeConfig {
  if (!isOiRuntimeConfig(value)) {
    throw new BadRequestError("runtime_config OI 配置必须是对象");
  }
  const rc = value;
  if (rc.backend !== "native" && rc.backend !== "wasm") {
    throw new BadRequestError("runtime_config.backend 仅允许 native / wasm");
  }
  if (
    !Array.isArray(rc.languages) || rc.languages.length === 0 ||
    rc.languages.some((language) => language !== "c" && language !== "cpp") ||
    new Set(rc.languages).size !== rc.languages.length
  ) {
    throw new BadRequestError(
      "runtime_config.languages 必须是非空且不重复的 c/cpp 数组",
    );
  }
  for (
    const [field, value] of [
      ["time_limit_ms", rc.time_limit_ms],
      ["memory_limit_mb", rc.memory_limit_mb],
    ] as const
  ) {
    if (
      typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0
    ) {
      throw new BadRequestError(`runtime_config.${field} 必须为正整数`);
    }
  }
  if (!rc.checker || typeof rc.checker !== "object") {
    throw new BadRequestError("runtime_config.checker 必须是对象");
  }
  if (!(["default", "strict", "testlib"] as const).includes(rc.checker.type)) {
    throw new BadRequestError(
      "runtime_config.checker.type 仅允许 default / strict / testlib",
    );
  }
  if (rc.checker.path !== undefined && !isSafeOiPath(rc.checker.path)) {
    throw new BadRequestError(
      "runtime_config.checker.path 必须是安全的相对路径",
    );
  }
  if (rc.checker.type === "testlib" && !rc.checker.path) {
    throw new BadRequestError("testlib checker 必须提供 checker.path");
  }
  if (rc.checker.type !== "testlib" && rc.checker.path !== undefined) {
    throw new BadRequestError("内置 checker 不允许指定 checker.path");
  }
  if (!Array.isArray(rc.subtasks) || rc.subtasks.length === 0) {
    throw new BadRequestError("runtime_config.subtasks 必须是非空数组");
  }
  const ids = new Set<string>();
  const inputPaths = new Set<string>();
  let totalScore = 0;
  for (const [index, subtask] of rc.subtasks.entries()) {
    if (
      !subtask || typeof subtask !== "object" ||
      typeof subtask.id !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(subtask.id) || ids.has(subtask.id)
    ) {
      throw new BadRequestError(
        `runtime_config.subtasks[${index}].id 非法或重复`,
      );
    }
    ids.add(subtask.id);
    if (
      typeof subtask.score !== "number" ||
      !Number.isSafeInteger(subtask.score) ||
      subtask.score <= 0
    ) {
      throw new BadRequestError(
        `runtime_config.subtasks[${index}].score 必须为正整数`,
      );
    }
    totalScore += subtask.score;
    if ("scoring" in subtask && subtask.scoring !== "all") {
      throw new BadRequestError(
        `runtime_config.subtasks[${index}].scoring 仅允许 all`,
      );
    }
    if (!Array.isArray(subtask.cases) || subtask.cases.length === 0) {
      throw new BadRequestError(
        `runtime_config.subtasks[${index}].cases 不能为空`,
      );
    }
    for (const [caseIndex, testCase] of subtask.cases.entries()) {
      if (
        !testCase || typeof testCase !== "object" ||
        !isSafeOiPath(testCase.input) || !isSafeOiPath(testCase.output)
      ) {
        throw new BadRequestError(
          `runtime_config.subtasks[${index}].cases[${caseIndex}] 的 input/output 必须是安全相对路径`,
        );
      }
      if (
        testCase.input === testCase.output || inputPaths.has(testCase.input)
      ) {
        throw new BadRequestError(
          `runtime_config.subtasks[${index}].cases[${caseIndex}].input 重复或与 output 相同`,
        );
      }
      inputPaths.add(testCase.input);
      for (
        const [field, value] of [
          ["time_limit_ms", testCase.time_limit_ms],
          ["memory_limit_mb", testCase.memory_limit_mb],
        ] as const
      ) {
        if (
          value !== undefined &&
          (typeof value !== "number" || !Number.isSafeInteger(value) ||
            value <= 0)
        ) {
          throw new BadRequestError(
            `runtime_config.subtasks[${index}].cases[${caseIndex}].${field} 必须为正整数`,
          );
        }
      }
    }
    for (
      const [field, value] of [
        ["time_limit_ms", subtask.time_limit_ms],
        ["memory_limit_mb", subtask.memory_limit_mb],
      ] as const
    ) {
      if (
        value !== undefined &&
        (typeof value !== "number" || !Number.isSafeInteger(value) ||
          value <= 0)
      ) {
        throw new BadRequestError(
          `runtime_config.subtasks[${index}].${field} 必须为正整数`,
        );
      }
    }
    if (subtask.depends_on !== undefined) {
      if (
        !Array.isArray(subtask.depends_on) ||
        subtask.depends_on.some((id) =>
          typeof id !== "string" || id === subtask.id
        ) ||
        new Set(subtask.depends_on).size !== subtask.depends_on.length
      ) {
        throw new BadRequestError(
          `runtime_config.subtasks[${index}].depends_on 非法（不得自依赖）`,
        );
      }
    }
  }
  if (totalScore !== 100) {
    throw new BadRequestError("runtime_config.subtasks.score 总和必须为 100");
  }
  // 先验证引用存在，再用 DFS 拒绝环，保证 scorer 可以按声明顺序稳定处理。
  const byId = new Map(rc.subtasks.map((subtask) => [subtask.id, subtask]));
  for (const subtask of rc.subtasks) {
    for (const dependency of subtask.depends_on ?? []) {
      if (!byId.has(dependency)) {
        throw new BadRequestError(
          `runtime_config.subtasks.${subtask.id}.depends_on 引用了不存在的子任务 ${dependency}`,
        );
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      throw new BadRequestError(
        "runtime_config.subtasks.depends_on 不能形成循环",
      );
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.depends_on ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const subtask of rc.subtasks) visit(subtask.id);
}

/** 根据运行配置推断任务模式，兼容存量双容器题目。 */
export function judgeTypeForRuntimeConfig(value: unknown): JudgeType {
  return isOiRuntimeConfig(value) ? "oi" : "dual";
}
