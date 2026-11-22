import type { TeachingItem } from './education.ts';

export interface AssignmentRemediationPreview {
  source: { kind: 'assignment'; id: string; title: string; revision: number; scope: 'on_time' | 'current' };
  preview_token: string;
  updating: boolean;
  students: { user_id: string; username: string; item_ids: string[] }[];
  items: (
    & Pick<
      TeachingItem,
      'id' | 'reference' | 'requirement' | 'minimum_score' | 'resource_available' | 'policy_revision'
    >
    & { binding_id: string | null; label?: string }
  )[];
  excluded: { pending_cells: number; unavailable_items: number; historical_students: number; nonparticipants?: number };
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
export interface ContestRemediationCriteria {
  contest_id: string;
  ranking_source: 'live' | 'official';
  requirement: 'accepted' | 'min_score';
  minimum_score?: number;
}
export interface ContestRemediationPreview extends Omit<AssignmentRemediationPreview, 'source' | 'items'> {
  source: {
    kind: 'contest';
    id: string;
    title: string;
    revision: number;
    ranking_source: 'live' | 'official';
    snapshot_version: number | null;
  };
  items: (AssignmentRemediationPreview['items'][number] & { label: string })[];
}
export interface ContestRemediationInput extends ContestRemediationCriteria, RemediationSelectionInput {
  preview_token: string;
}
