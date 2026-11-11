/**
 * 功能自声明（core 重构阶段 2，见 openspec/changes/refactor-core-feature-slices）。
 *
 * 每个 `src/features/<name>/index.ts` 导出 `feature = defineFeature({...})`，
 * 声明自己的路由、后台任务、常驻 worker 与观测注册；应用只遍历
 * `src/features.ts` 中的清单完成装配，不再在别处手工登记。
 */
import type { Hono } from "hono";
import type { AuthEnv } from "./http/hono-env.ts";
import type { ObservabilityRegistry } from "./observability/index.ts";
import type { ManagedTask } from "./runtime/managed-task.ts";
import type {
  FeatureTaskType,
  TaskHandler,
} from "../modules/runtime/tasks/contracts.ts";

/** 功能名：小写 kebab-case，与 `src/features/<name>/` 目录名一致。 */
const FEATURE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** 功能声明。所有字段除 `name` 外均可省略。 */
export interface FeatureDefinition {
  /** 功能名，同时是目录名与 `test:domain` 目标名。 */
  readonly name: string;
  /** 挂载在 `/api/v1` 下的路由；路径在路由内部声明。 */
  readonly router?: Hono<AuthEnv>;
  /** 后台任务处理器；键为任务类型，必须以 `<name>.` 开头。 */
  readonly tasks?: Readonly<Record<FeatureTaskType, TaskHandler>>;
  /** 常驻 worker 启动函数；由启动流程登记进统一任务组，关闭时逆序停止。 */
  readonly workers?: readonly (() => ManagedTask)[];
  /** 指标与健康探针注册。 */
  readonly observability?: (registry: ObservabilityRegistry) => void;
}

/** 校验并冻结功能声明；不合法时在模块加载期直接抛错。 */
export function defineFeature<T extends FeatureDefinition>(definition: T): T {
  if (!FEATURE_NAME_PATTERN.test(definition.name)) {
    throw new TypeError(
      `功能名 "${definition.name}" 不合法：必须是小写 kebab-case，且与 src/features/<name>/ 目录名一致`,
    );
  }
  for (const taskType of Object.keys(definition.tasks ?? {})) {
    if (!taskType.startsWith(`${definition.name}.`)) {
      throw new TypeError(
        `功能 ${definition.name} 的任务类型 "${taskType}" 必须以 "${definition.name}." 开头`,
      );
    }
  }
  return Object.freeze(definition);
}

/**
 * 汇总功能清单的任务处理器。
 *
 * 功能名重复、任务类型重复或与内置任务类型冲突时抛错——启动期失败，
 * 不允许后声明的处理器静默覆盖先声明的。
 */
export function collectFeatureTasks(
  features: readonly FeatureDefinition[],
  builtinTaskTypes: readonly string[],
): Record<FeatureTaskType, TaskHandler> {
  const names = new Set<string>();
  const builtin = new Set(builtinTaskTypes);
  const handlers: Record<FeatureTaskType, TaskHandler> = {};
  for (const feature of features) {
    if (names.has(feature.name)) {
      throw new TypeError(`功能清单中 "${feature.name}" 重复`);
    }
    names.add(feature.name);
    for (const [taskType, handler] of Object.entries(feature.tasks ?? {})) {
      if (builtin.has(taskType)) {
        throw new TypeError(
          `功能 ${feature.name} 的任务类型 "${taskType}" 与内置任务类型冲突`,
        );
      }
      if (taskType in handlers) {
        throw new TypeError(`任务类型 "${taskType}" 被多个功能声明`);
      }
      handlers[taskType as FeatureTaskType] = handler;
    }
  }
  return handlers;
}
