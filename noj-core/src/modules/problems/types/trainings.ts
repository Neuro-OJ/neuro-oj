/**
 * 题单（training）类型定义（issue #224）。
 *
 * 0.11 起题单只存在于域内（`/api/v1/domains/:slug/trainings`），旧的实例级
 * `/api/v1/trainings` 读写入口已删除；这里只保留可见性枚举与校验函数。
 */

export const TRAINING_VISIBILITIES = ["private", "unlisted", "public"] as const;
export type TrainingVisibility = typeof TRAINING_VISIBILITIES[number];

export function isValidTrainingVisibility(
  value: string,
): value is TrainingVisibility {
  return TRAINING_VISIBILITIES.includes(value as TrainingVisibility);
}
