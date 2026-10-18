import type { DomainProblemReference, DomainProblemSummary } from './domain-problems.ts';
export interface DomainTrainingInput {
  title: string;
  description: string;
  visibility: 'private' | 'unlisted' | 'public';
  problems: string[];
}
export interface DomainTrainingDetail {
  id: string;
  domain_id: string;
  source_domain_id: string;
  source_domain_slug: string;
  title: string;
  description: string;
  revision: number;
  visibility: DomainTrainingInput['visibility'];
  is_shared: boolean;
  can_edit: boolean;
  can_share: boolean;
  items: Array<
    DomainProblemReference & {
      binding_id: string | null;
      position: number;
      resource_available: boolean;
      can_import: boolean;
    }
  >;
}
export type TrainingViewItem = DomainTrainingDetail['items'][number] & {
  title: string | null;
  kind: DomainProblemSummary['kind'] | null;
  progress: DomainProblemSummary['progress'];
  summary_error: boolean;
};
export interface TrainingView {
  training: Omit<DomainTrainingDetail, 'items'>;
  items: TrainingViewItem[];
  page: number;
  per_page: number;
  total: number;
}
