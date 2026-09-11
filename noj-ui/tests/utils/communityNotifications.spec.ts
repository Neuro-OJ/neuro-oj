/**
 * 通知展示/跳转规则回归测试。
 *
 * 背景：列表页原先在选择链末尾 `return "/community"`，导致「没有可跳转关联内容」
 * 的通知（封禁通知、内容已删除、触发者已注销）点击后跳到社区首页。
 * 现在这类通知必须走 `null`，由调用方进入通知详情页。
 */
import { describe, expect, it } from 'vitest';

import {
  NOTIFICATION_TYPE_ICON,
  NOTIFICATION_TYPE_LABEL,
  notificationDetailUrl,
  notificationTarget,
  type NotificationTargetSource,
  notificationTypeIcon,
  notificationTypeLabel,
} from '~/utils/communityNotifications';

function row(
  overrides: Partial<NotificationTargetSource['notification']> = {},
  actor: NotificationTargetSource['actor'] = null,
): NotificationTargetSource {
  return {
    notification: {
      type: 'reply',
      post_id: null,
      data: {},
      ...overrides,
    },
    actor,
  };
}

describe('notificationTarget', () => {
  it('reply/like 指向关联帖子', () => {
    expect(notificationTarget(row({ type: 'reply', post_id: 'p1' }))).toBe('/community/posts/p1');
    expect(notificationTarget(row({ type: 'like', post_id: 'p2' }))).toBe('/community/posts/p2');
  });

  it('report 优先指向举报工单（即使带 post_id）', () => {
    expect(
      notificationTarget(row({ type: 'report', post_id: 'p1', data: { report_id: 'r1' } })),
    ).toBe('/community/reports/r1');
  });

  it('follow 指向触发者主页', () => {
    expect(notificationTarget(row({ type: 'follow' }, { username: 'alice' }))).toBe('/users/alice');
  });

  it('clarification 指向竞赛答疑 Tab', () => {
    expect(
      notificationTarget(row({ type: 'clarification', data: { contest_id: 'c1' } })),
    ).toBe('/contests/c1?tab=clarifications');
  });

  it('封禁通知没有关联内容 → null（回归：曾回退到 /community）', () => {
    const ban = row({
      type: 'ban',
      data: { scope: 'platform', reason: '违规', banned_at: '2026-01-01T00:00:00.000Z' },
    });
    expect(notificationTarget(ban)).toBeNull();
  });

  it('帖子已删除（post_id 置空）→ null', () => {
    expect(notificationTarget(row({ type: 'reply', post_id: null }))).toBeNull();
    expect(notificationTarget(row({ type: 'like', post_id: null }))).toBeNull();
  });

  it('触发者已注销（actor 为 null）的 follow → null', () => {
    expect(notificationTarget(row({ type: 'follow' }, null))).toBeNull();
  });

  it('缺少 report_id 的 report → null', () => {
    expect(notificationTarget(row({ type: 'report', data: {} }))).toBeNull();
  });

  it('缺少 contest_id 的 clarification → null', () => {
    expect(notificationTarget(row({ type: 'clarification', data: {} }))).toBeNull();
  });

  it('任何情况下都不再返回 /community 兜底', () => {
    const cases: NotificationTargetSource[] = [
      row({ type: 'ban' }),
      row({ type: 'reply', post_id: null }),
      row({ type: 'moderation', post_id: null }),
      row({ type: 'follow' }, null),
      row({ type: 'report', data: {} }),
    ];
    for (const item of cases) {
      expect(notificationTarget(item)).not.toBe('/community');
    }
  });
});

describe('通知类型文案与图标', () => {
  it('覆盖全部 7 种后端类型', () => {
    const types = ['reply', 'like', 'follow', 'moderation', 'clarification', 'report', 'ban'];
    for (const type of types) {
      expect(NOTIFICATION_TYPE_LABEL[type as keyof typeof NOTIFICATION_TYPE_LABEL]).toBeTruthy();
      expect(NOTIFICATION_TYPE_ICON[type as keyof typeof NOTIFICATION_TYPE_ICON]).toBeTruthy();
    }
  });

  it('未知类型回退原始值与通用图标', () => {
    expect(notificationTypeLabel('future_type')).toBe('future_type');
    expect(notificationTypeIcon('future_type')).toBe('i-lucide-bell');
  });
});

describe('notificationDetailUrl', () => {
  it('拼出通知详情页路径', () => {
    expect(notificationDetailUrl('n1')).toBe('/community/notifications/n1');
  });
});
