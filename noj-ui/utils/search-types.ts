/**
 * 搜索相关纯类型定义。
 *
 * 独立成模块，避免 `utils/` 在 Deno 类型检查时拉入 Nuxt/Vue composable。
 */

export type SearchEntityType =
  | 'problem'
  | 'user'
  | 'community_post'
  | 'community_comment'
  | 'contest'
  | 'submission'
  | 'message'
  | 'announcement';

export type SearchType = 'all' | SearchEntityType;

export interface SearchItem {
  entity_type: SearchEntityType;
  entity_id: string;
  title: string;
  highlight: string;
  rank: number;
  metadata: Record<string, unknown>;
}

export interface SearchState {
  open: boolean;
  query: string;
  type: SearchType;
  groups: Record<string, { items: SearchItem[]; has_more: boolean }>;
  flatItems: SearchItem[];
  hasMore: boolean;
  page: number;
  loading: boolean;
  error: string | null;
}
