import type { TeachingItem } from './education';

export interface AssignmentRemediationPreview {
  source: { kind: 'assignment'; id: string; title: string; revision: number; scope: 'on_time' | 'current' };
  preview_token: string;
  updating: boolean;
  students: { user_id: string; username: string; item_ids: string[] }[];
  items: Pick<
    TeachingItem,
    'id' | 'reference' | 'binding_id' | 'requirement' | 'minimum_score' | 'resource_available' | 'policy_revision'
  >[];
  excluded: { pending_cells: number; unavailable_items: number; historical_students: number };
}
export interface RemediationSelectionInput {
  title: string;
  target_student_ids: string[];
  item_ids: string[];
  deadline_at: string | null;
}
export interface AssignmentRemediationInput extends RemediationSelectionInput {
  scope: 'on_time' | 'current';
  preview_token: string;
}
