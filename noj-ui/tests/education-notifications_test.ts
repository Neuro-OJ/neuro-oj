/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix
import { assertEquals } from 'jsr:@std/assert@^1';
import { teachingNoticeTarget } from '../utils/education-notifications.ts';
import type { TeachingNotice } from '../utils/education-notifications.ts';
Deno.test('教学通知：链接保留使用域，反馈与求助只传定位，不传成绩或正文', () => {
  const notice = { assignment_id: 'task', type: 'help_reply', help_id: 'help', feedback_id: null } as TeachingNotice;
  assertEquals(teachingNoticeTarget('school-one', notice), {
    path: '/d/school-one/assignments/task',
    query: { help: 'help' },
  });
  assertEquals(
    teachingNoticeTarget('school-two', { ...notice, type: 'feedback', help_id: null, feedback_id: 'feedback' }),
    { path: '/d/school-two/assignments/task', query: { feedback: 'feedback' } },
  );
});
Deno.test('教学通知：变化与资源失效打开受控历史，不跳往来源域内容', () => {
  const notice = {
    assignment_id: 'task',
    type: 'resource_unavailable',
    help_id: null,
    feedback_id: null,
  } as TeachingNotice;
  assertEquals(teachingNoticeTarget('school', notice), { path: '/d/school/assignments/task', query: { history: '1' } });
});
