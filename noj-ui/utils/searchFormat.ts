/**
 * 统一搜索展示格式化工具。
 *
 * 将 SearchResultItem / SearchPalette / pages/search 中重复的
 * 类型标签、链接构造、图标与次要元信息逻辑集中到一处。
 */

import type { SearchItem } from '~/composables/useSearch';
import { problemUrl, publicUrl, userUrl } from './publicIdentifiers.ts';

const TYPE_LABELS: Record<string, string> = {
  problem: '题目',
  user: '用户',
  community_post: '帖子',
  community_comment: '评论',
  contest: '竞赛',
  submission: '提交',
  message: '消息',
  announcement: '公告',
};

const ICON_TEXTS: Record<string, string> = {
  problem: '题',
  user: '用',
  community_post: '帖',
  community_comment: '评',
  contest: '赛',
  submission: '交',
  message: '信',
  announcement: '告',
};

const ICON_CLASSES: Record<string, string> = {
  problem: 'bg-primary-bg text-primary',
  user: 'bg-blue-50 text-info-text',
  community_post: 'bg-amber-50 text-amber-700',
  community_comment: 'bg-amber-50 text-amber-700',
  contest: 'bg-purple-50 text-purple-700',
  submission: 'bg-gray-100 text-gray-700',
  message: 'bg-green-50 text-green-700',
  announcement: 'bg-red-50 text-red-700',
};

const DIFFICULTY_LABELS: Record<string, string> = {
  easy: '简单',
  medium: '中等',
  hard: '困难',
};

const POST_TYPE_LABELS: Record<string, string> = {
  solution: '题解',
  discussion: '讨论',
};

/** 实体类型 → 中文标签。 */
export function typeLabel(type: string): string {
  return TYPE_LABELS[type] ?? type;
}

/** 搜索项 → 详情页链接。fallback 用于默认/未知类型时的兜底地址。 */
export function itemHref(item: SearchItem, fallback = ''): string {
  switch (item.entity_type) {
    case 'problem':
      return problemUrl(item.entity_id, String(item.metadata.display_id ?? ''));
    case 'user':
      return userUrl(String(item.metadata.username ?? ''));
    case 'community_post':
      return publicUrl('post', String(item.metadata.public_id ?? item.entity_id));
    case 'community_comment':
      return publicUrl(
        'post',
        String(item.metadata.post_public_id ?? item.metadata.post_id ?? item.entity_id),
      );
    case 'contest':
      return `/contests/${item.entity_id}`;
    case 'submission':
      return `/submissions/${item.entity_id}`;
    case 'message':
      return `/messages?conversation=${String(item.metadata.conversation_id ?? '')}`;
    case 'announcement':
      return `/announcements/${item.entity_id}`;
    default:
      return fallback;
  }
}

/**
 * 图标文字；problem 类型优先展示 display_id，与旧的 SearchResultItem 行为保持一致。
 */
export function iconText(
  type: string,
  metadata?: Record<string, unknown>,
): string {
  if (type === 'problem') {
    return String(metadata?.display_id ?? ICON_TEXTS.problem);
  }
  return ICON_TEXTS[type] ?? '搜';
}

/** 图标底色/文字颜色。 */
export function iconClass(type: string): string {
  const base = 'flex-shrink-0 w-10 h-10 rounded-md flex items-center justify-center text-sm font-mono font-semibold';
  return `${base} ${ICON_CLASSES[type] ?? 'bg-gray-100 text-gray-700'}`;
}

/** 搜索项次要元信息行。 */
export function metaLine(item: SearchItem): string {
  const m = item.metadata as Record<string, unknown>;
  switch (item.entity_type) {
    case 'problem': {
      const difficulty = DIFFICULTY_LABELS[String(m.difficulty ?? '')] ??
        String(m.difficulty ?? '');
      return `${difficulty} · 相关度 ${(item.rank * 100).toFixed(0)}`;
    }
    case 'user':
      return String(m.email ?? '');
    case 'community_post': {
      const postType = POST_TYPE_LABELS[String(m.post_type ?? '')] ??
        String(m.post_type ?? '');
      return `${postType} · ${String(m.author_username ?? '')}`;
    }
    case 'community_comment':
      return `评论 · ${String(m.author_username ?? '')}`;
    case 'contest':
      return `${String(m.kind ?? '')} · ${String(m.is_public ? '公开' : '邀请')}`;
    case 'submission':
      return `${String(m.language ?? '')} · ${String(m.status ?? '')}`;
    case 'message':
      return `私信 · ${String(m.sent_at ?? '')}`;
    case 'announcement':
      return '公告';
    default:
      return '';
  }
}
