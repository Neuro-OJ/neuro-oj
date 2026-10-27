// deno-lint-ignore no-import-prefix
import { assertEquals, assertNotEquals } from 'jsr:@std/assert@^1';
import { communityApiPath, communityPath, communityScopeKey } from '../utils/community-workspace.ts';
import { notificationDetailUrl, notificationTarget } from '../utils/communityNotifications.ts';
import { defaultWorkspaceDestination } from '../utils/default-workspace.ts';

Deno.test('域社区入口与缓存不会把同一账号或同一帖子切换为其他域', () => {
  assertEquals(
    communityApiPath('school-a', 'posts/post/comments'),
    '/api/v1/domains/school-a/community/posts/post/comments',
  );
  assertEquals(communityPath('school-b', 'posts/post'), '/d/school-b/community/posts/post');
  assertNotEquals(communityScopeKey('school-a', 'student'), communityScopeKey('school-b', 'student'));
  assertNotEquals(communityScopeKey('school-a', 'student'), communityScopeKey('school-a', null));
  assertNotEquals(communityScopeKey(null, 'student'), communityScopeKey('main', 'student'));
});
Deno.test('域通知目标留在使用域，关注仍是账号关系，账号举报不强塞main', () => {
  const notification = { type: 'reply', post_id: 'same-post', data: {} }, actor = { username: 'teacher' };
  assertEquals(notificationTarget({ notification, actor }, 'school'), '/d/school/community/posts/same-post');
  assertEquals(
    notificationTarget({ notification: { ...notification, type: 'follow', post_id: null }, actor }, 'school'),
    '/users/teacher',
  );
  assertEquals(
    notificationTarget(
      { notification: { type: 'report', post_id: null, data: { report_id: 'ticket' } }, actor },
      'school',
    ),
    '/d/school/community/reports/ticket',
  );
  assertEquals(
    notificationTarget({ notification: { type: 'report', post_id: null, data: { report_id: 'dm' } }, actor }),
    '/community/reports/dm',
  );
  assertEquals(
    notificationTarget({
      notification: { type: 'clarification', post_id: null, data: { contest_id: 'contest' } },
      actor,
    }, 'school'),
    '/d/school/contests/contest?tab=clarifications',
  );
  assertEquals(notificationDetailUrl('deleted-target', 'school'), '/notifications/deleted-target');
  assertEquals(communityApiPath(null, 'notifications'), '/api/v1/community/notifications');
});
Deno.test('旧内容链接固定main，账号通知与私信举报继续自己的授权入口', () => {
  assertEquals(defaultWorkspaceDestination('/community'), { path: '/d/main/community' });
  assertEquals(defaultWorkspaceDestination('/community/posts/post'), { path: '/d/main/community/posts/post' });
  assertEquals(defaultWorkspaceDestination('/community/bookmarks'), { path: '/d/main/community/bookmarks' });
  assertEquals(defaultWorkspaceDestination('/community/notifications'), null);
  assertEquals(defaultWorkspaceDestination('/community/reports/dm'), null);
});
