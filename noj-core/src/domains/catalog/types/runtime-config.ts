import { BadRequestError } from "../../../shared/base/errors.ts";

/** 题目评测模式。 */
export type JudgeType = "dual" | "oi";

/** 可公开的执行后端名称；客观题或无有效 OI 配置时为空。 */
export type JudgeBackend = "dual" | "oi-native" | "oi-wasm";

/** 提取执行后端标识，不暴露测试数据、checker 或存储配置。 */
export function getJudgeBackend(
  judgeType: string | null | undefined,
  config: unknown,
  isObjective = false,
): JudgeBackend | null {
  if (isObjective) return null;
  if (judgeType !== "oi") return "dual";
  return isOiRuntimeConfig(config) ? `oi-${config.backend}` : null;
}

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
  languages: Array<"c" | "cc">;
  time_limit_ms: number;
  memory_limit_mb: number;
  checker: { type: "default" | "strict" | "testlib"; path?: string };
  subtasks: OiSubtask[];
  filename?: string;
  compile_extra_files?: string[];
  /** 仅注入受信 checker 编译/运行沙箱；Hydro judge_extra_files 映射到这里。 */
  checker_extra_files?: string[];
  user_extra_files?: string[];
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
    !value.includes("\0") && !/^[A-Za-z]:/.test(value) &&
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
  for (
    const key of [
      "cost_profile",
      "oi_cost_profile",
      "wasm_costs",
      "fuel_per_ms",
    ]
  ) {
    if (key in rc) throw new BadRequestError("WASM 成本只能由服务器注入");
  }
  if (rc.filename !== undefined && !/^[A-Za-z0-9_-]+$/.test(rc.filename)) {
    throw new BadRequestError("filename 必须是安全文件名前缀");
  }
  for (
    const paths of [
      rc.compile_extra_files,
      rc.checker_extra_files,
      rc.user_extra_files,
    ]
  ) {
    if (
      paths !== undefined &&
      (!Array.isArray(paths) || paths.some((p) => !isSafeOiPath(p)) ||
        new Set(paths).size !== paths.length)
    ) {
      throw new BadRequestError("extra_files 必须是不重复的安全相对路径数组");
    }
  }
  if (rc.backend !== "native" && rc.backend !== "wasm") {
    throw new BadRequestError("runtime_config.backend 仅允许 native / wasm");
  }
  if (
    !Array.isArray(rc.languages) || rc.languages.length === 0 ||
    rc.languages.some((language) => language !== "c" && language !== "cc") ||
    new Set(rc.languages).size !== rc.languages.length
  ) {
    throw new BadRequestError(
      "runtime_config.languages 必须是非空且不重复的 c/cc 数组",
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
  const casePaths = new Set<string>();
  const protectedPaths = new Set<string>();
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
      !Number.isFinite(subtask.score) ||
      Math.abs(subtask.score * 100 - Math.round(subtask.score * 100)) > 1e-7 ||
      subtask.score <= 0
    ) {
      throw new BadRequestError(
        `runtime_config.subtasks[${index}].score 必须是最多两位小数的正数`,
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
        testCase.input === testCase.output ||
        casePaths.has(testCase.input) ||
        casePaths.has(testCase.output)
      ) {
        throw new BadRequestError(
          `runtime_config.subtasks[${index}].cases[${caseIndex}] 的 input/output 路径重复或相同`,
        );
      }
      casePaths.add(testCase.input);
      casePaths.add(testCase.output);
      protectedPaths.add(testCase.input);
      protectedPaths.add(testCase.output);
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
  let caseCount = 0;
  let totalTime = 0;
  const checkMemory = (memory: number) => {
    if (memory > 512) throw new BadRequestError("OI 内存上限为 512 MiB");
  };
  checkMemory(rc.memory_limit_mb);
  for (const subtask of rc.subtasks) {
    checkMemory(subtask.memory_limit_mb ?? rc.memory_limit_mb);
    for (const testCase of subtask.cases) {
      caseCount++;
      totalTime += testCase.time_limit_ms ?? subtask.time_limit_ms ??
        rc.time_limit_ms;
      checkMemory(
        testCase.memory_limit_mb ?? subtask.memory_limit_mb ??
          rc.memory_limit_mb,
      );
    }
  }
  if (caseCount > 100) throw new BadRequestError("OI 最多 100 个测试点");
  // WASM 限额是固定工作量，不能沿用原生 CPU 毫秒的总预算上限。
  // 宿主实际耗时仍由 Worker 的外层任务墙钟保护独立约束。
  const totalTimeLimit = rc.backend === "wasm" ? 300000 : 60000;
  if (totalTime > totalTimeLimit) {
    throw new BadRequestError(
      rc.backend === "wasm"
        ? "OI WASM 测试点总预算最多 300000 NOJ 参考毫秒"
        : "OI 测试点总时限最多 60000ms",
    );
  }
  if (Math.abs(totalScore - 100) > 1e-7) {
    throw new BadRequestError("runtime_config.subtasks.score 总和必须为 100");
  }
  if (rc.filename) {
    const generatedPaths = [`${rc.filename}.in`, `${rc.filename}.out`];
    if (generatedPaths.some((path) => protectedPaths.has(path))) {
      throw new BadRequestError(
        "filename 生成的输入/输出文件不能与测试点文件重复",
      );
    }
    for (const path of generatedPaths) protectedPaths.add(path);
  }
  if (rc.checker.path) {
    if (protectedPaths.has(rc.checker.path)) {
      throw new BadRequestError(
        "checker.path 不能引用测试输入、标准答案或 filename 生成文件",
      );
    }
    protectedPaths.add(rc.checker.path);
  }
  for (
    const [field, paths] of [
      ["compile_extra_files", rc.compile_extra_files],
      ["checker_extra_files", rc.checker_extra_files],
      ["user_extra_files", rc.user_extra_files],
    ] as const
  ) {
    if (paths?.some((path) => protectedPaths.has(path))) {
      throw new BadRequestError(
        `${field} 不能引用测试输入、标准答案或 checker 文件`,
      );
    }
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
