import type { UserSummary } from './user-identity.ts';

/** 原文身份与使用域分开，任何共享引用仍在使用域中授权。 */
export type AnnotationTarget =
  | { kind: 'problem'; reference: string; version_id?: string; field: string; contest_id?: string }
  | { kind: 'submission'; submission_id: string; file_name: string }
  | { kind: 'solution'; post_id: string };
export interface AnnotationBlock {
  id: string;
  text: string;
  start_line: number;
}
export interface AnnotationSource {
  target: AnnotationTarget;
  target_key?: string;
  content_hash: string;
  content?: string;
  blocks: AnnotationBlock[];
  student_id?: string | null;
  href: string;
  source_changed?: boolean;
}
export interface AnnotationAnchor {
  block_id: string;
  start: number;
  end: number;
  quote: string;
  before?: string;
  after?: string;
  start_line: number;
  end_line: number;
}
export interface AnnotationSummary {
  id: string;
  owner_id: string;
  student_id: string | null;
  visibility: 'private' | 'teaching';
  author: UserSummary;
  target: AnnotationTarget;
  anchor: AnnotationAnchor;
  content_hash: string;
  state: 'open' | 'resolved';
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface AnnotationMessage {
  id: string;
  author_id: string;
  author: UserSummary;
  body: string | null;
  revision: number;
  withdrawn_at: string | null;
  created_at: string;
}
export interface AnnotationDetail extends AnnotationSummary {
  href: string;
  source_changed: boolean;
  can_reply: boolean;
  messages: AnnotationMessage[];
  page: number;
  per_page: number;
  total: number;
}
export interface AnnotationPage {
  actor_id: string | null;
  domain_slug: string;
  data: AnnotationSummary[];
  next_cursor: string | null;
}

/** 选中文字对应多个位置时保留全部候选，要求用户确认来源块。 */
export function annotationSelection(blocks: AnnotationBlock[], quote: string) {
  const result: { block_id: string; start: number; end: number }[] = [];
  if (!quote) return result;
  for (const block of blocks) {
    let offset = block.text.indexOf(quote);
    while (offset >= 0) {
      result.push({ block_id: block.id, start: offset, end: offset + quote.length });
      offset = block.text.indexOf(quote, offset + Math.max(quote.length, 1));
    }
  }
  return result;
}
