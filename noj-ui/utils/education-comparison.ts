import type { DomainProblemReference } from './domain-problems.ts';
export interface TrainingComparisonWindows {
  before_start: string;
  before_end: string;
  after_start: string;
  after_end: string;
}
export interface TrainingComparisonSource {
  submission_id: string;
  source_kind: 'submission' | 'objective';
  received_at: string;
  attempt_id: string | null;
  version_id: string | null;
  score: number | null;
  accepted: boolean;
}
export interface TrainingComparisonPeriod {
  submitted_count: number;
  candidate_count: number;
  pending_count: number;
  version_mismatch_count: number;
  score: number | null;
  accepted: boolean;
  achieved: boolean;
  best: TrainingComparisonSource | null;
  passed: TrainingComparisonSource | null;
}
export interface TrainingComparisonData {
  assignment_id: string;
  user_id: string;
  domain_id: string;
  windows: TrainingComparisonWindows;
  interval: '[start,end)';
  strategy: 'current_domain_policy';
  computed_at: string;
  interpretation: string;
  before: {
    accepted_items: number;
    achieved_items: number;
    scored_items: number;
    submitted_count: number;
    candidate_count: number;
  };
  after: TrainingComparisonData['before'];
  items: Array<{
    item_id: string;
    reference: DomainProblemReference;
    requirement: 'accepted' | 'min_score';
    minimum_score: number | null;
    resource_available: boolean;
    policy: {
      mode: 'any' | 'exact';
      required_version_id: string | null;
      revision: number;
      answer_version_id: string | null;
    };
    before: TrainingComparisonPeriod;
    after: TrainingComparisonPeriod;
    score_change: number | null;
  }>;
}
