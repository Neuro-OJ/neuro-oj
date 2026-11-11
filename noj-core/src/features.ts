/**
 * 功能清单：一行一个功能（core 重构阶段 2）。
 *
 * 新功能放在 `src/features/<name>/`，在其 `index.ts` 中
 * `export const feature = defineFeature({...})`，然后在这里加一行。
 * 路由、后台任务、worker 与观测由 `createApp` / 启动流程遍历本清单装配，
 * 不需要在其他位置登记。结构约定见
 * openspec/changes/refactor-core-feature-slices/design.md。
 */
import type { FeatureDefinition } from "./shared/feature.ts";
import * as checkin from "./features/checkin/index.ts";
import * as legal from "./features/legal/index.ts";
import * as tags from "./features/tags/index.ts";
import * as trainings from "./features/trainings/index.ts";

/** 已迁入 `features/` 结构的功能（迁移期与旧 `modules/` 并存）。 */
export const FEATURES: readonly FeatureDefinition[] = [
  trainings.feature,
  legal.feature,
  tags.feature,
  checkin.feature,
];
