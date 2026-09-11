/**
 * 社区通知共享工具：未读数探测、展示文案与跳转规则。
 *
 * 本文件是通知展示与跳转规则的单一事实源，列表页与详情页共用：
 * 通知的目标内容可能不存在——`ban`（封禁通知）本就与帖子无关，
 * `reply`/`like` 的帖子或评论被删除后外键会置空，`follow` 的触发者注销后
 * `actor` 为 `null`。这类通知一律进入详情页，而不是退回社区首页。
 */

import { publicUrl, userUrl } from './publicIdentifiers.ts';

/**
 * 判断是否需要加载社区通知未读数。
 *
 * 未读数接口只允许登录用户访问，公共布局不得为匿名用户发起请求。
 */
export function shouldLoadCommunityUnreadCount(
  user: unknown,
  communityEnabled: boolean | undefined,
): boolean {
  return Boolean(user) && communityEnabled === true;
}

/**
 * 未读数属于后台状态探测：认证失效时只清零角标，不应把公共页面跳转到登录页。
 */
export const COMMUNITY_UNREAD_COUNT_REQUEST_OPTIONS = {
  silent: true,
  redirectOnUnauthorized: false,
} as const;

/** 通知类型（与 noj-core `community_notifications_type_check` 约束一致） */
export type CommunityNotificationType =
  | 'reply'
  | 'like'
  | 'follow'
  | 'moderation'
  | 'clarification'
  | 'report'
  | 'ban';

/**
 * 解析通知目标所需的最小字段集。
 *
 * 刻意只声明用到的字段：`NotificationRow` 等更宽的类型可结构化满足它，
 * 从而避免 utils 反向依赖 composables。
 */
export interface NotificationTargetSource {
  notification: {
    type: CommunityNotificationType | string;
    post_id: string | null;
    data: {
      report_id?: string;
      contest_id?: string;
    };
  };
  actor: { username: string } | null;
}

/** 通知类型 → 中文动作描述 */
export const NOTIFICATION_TYPE_LABEL: Record<CommunityNotificationType, string> = {
  reply: '回复了你',
  like: '赞了你的内容',
  follow: '关注了你',
  moderation: '更新了内容审核状态',
  clarification: '回复了你的竞赛提问',
  report: '举报通知',
  ban: '封禁通知',
};

/** 通知类型 → Lucide 图标名 */
export const NOTIFICATION_TYPE_ICON: Record<CommunityNotificationType, string> = {
  reply: 'i-lucide-reply',
  like: 'i-lucide-heart',
  follow: 'i-lucide-user-plus',
  moderation: 'i-lucide-shield-check',
  clarification: 'i-lucide-message-circle-question',
  report: 'i-lucide-flag',
  ban: 'i-lucide-ban',
};

/** 通知类型 → 中文标签（未知类型回退原始值，便于排查新增类型） */
export function notificationTypeLabel(type: string): string {
  return NOTIFICATION_TYPE_LABEL[type as CommunityNotificationType] ?? type;
}

/** 通知类型 → 图标名（未知类型回退通用铃铛） */
export function notificationTypeIcon(type: string): string {
  return NOTIFICATION_TYPE_ICON[type as CommunityNotificationType] ?? 'i-lucide-bell';
}

/**
 * 解析通知对应的可跳转目标（关联内容）。
 *
 * @returns 目标路径；`null` 表示该通知没有可跳转的关联内容，
 *   调用方应改为进入通知详情页。
 */
export function notificationTarget(item: NotificationTargetSource): string | null {
  const { notification, actor } = item;
  if (notification.type === 'report' && notification.data.report_id) {
    return `/community/reports/${notification.data.report_id}`;
  }
  if (notification.post_id) return publicUrl('post', notification.post_id);
  if (notification.type === 'follow' && actor) return userUrl(actor.username);
  if (notification.type === 'clarification' && notification.data.contest_id) {
    return `${publicUrl('contest', notification.data.contest_id)}?tab=clarifications`;
  }
  return null;
}

/** 通知详情页路径 */
export function notificationDetailUrl(notificationId: string): string {
  return `/community/notifications/${notificationId}`;
}
