/**
 * 题单（training）类型定义（issue #224）。
 * 第一版为扁平题单：trainings + training_problems，题目按 position 排序。
 */

export const TRAINING_VISIBILITIES = ["private", "unlisted", "public"] as const;
export type TrainingVisibility = typeof TRAINING_VISIBILITIES[number];

export function isValidTrainingVisibility(
  value: string,
): value is TrainingVisibility {
  return TRAINING_VISIBILITIES.includes(value as TrainingVisibility);
}

export interface CreateTrainingInput {
  title: string;
  description?: string;
  visibility?: TrainingVisibility;
}

export interface UpdateTrainingInput {
  title?: string;
  description?: string;
  visibility?: TrainingVisibility;
  is_pinned?: boolean;
}

export interface TrainingResponse {
  id: string;
  title: string;
  description: string;
  visibility: TrainingVisibility;
  is_pinned: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
  problem_count: number;
}

export interface TrainingProblemResponse {
  training_id: string;
  problem_id: string;
  position: number;
  title: string;
  description: string;
  difficulty: string;
  display_id: string;
  type: string;
  is_objective: boolean;
  accepted: boolean;
}
