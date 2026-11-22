/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix
import { assertEquals } from 'jsr:@std/assert@^1';
import { teachingAttemptLabel, teachingSubmissionResult } from '../utils/education-submissions.ts';
import type { TeachingAttempt, TeachingSubmission } from '../utils/education-submissions.ts';
Deno.test('教学提交：缺少正式分数不展示零分或未通过', () => {
  const row = { score: null, accepted: false, status: 'finished', verdict: null } as TeachingSubmission;
  assertEquals(teachingSubmissionResult(row), '暂无有效成绩');
  assertEquals(teachingSubmissionResult({ ...row, status: 'judging' }), '评测中');
});
Deno.test('教学提交：满分不推断通过，只有accepted产生通过文案', () => {
  const row = { score: 10000, accepted: false, status: 'finished', verdict: null } as TeachingSubmission;
  assertEquals(teachingSubmissionResult(row), '100 分');
  assertEquals(teachingSubmissionResult({ ...row, accepted: true }), '已通过 · 100 分');
});
Deno.test('教学沿革：平台错误不冒充正式零分，正式分数保留权威判定', () => {
  const row = {
    result_kind: 'platform_error',
    score: 9000,
    accepted: false,
    state: 'error',
    verdict: null,
  } as TeachingAttempt;
  assertEquals(teachingAttemptLabel(row), '平台评测失败 · 待处理');
  assertEquals(teachingAttemptLabel({ ...row, result_kind: null, score: null, state: 'judging' }), '评测中');
  assertEquals(
    teachingAttemptLabel({ ...row, result_kind: 'graded', score: 10000, state: 'finished', verdict: 'WA' }),
    'WA · 100 分',
  );
});
