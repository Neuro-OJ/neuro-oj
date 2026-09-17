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
