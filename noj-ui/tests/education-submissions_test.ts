/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix
import { assertEquals } from 'jsr:@std/assert@^1';
import { teachingSubmissionResult } from '../utils/education-submissions.ts';
import type { TeachingSubmission } from '../utils/education-submissions.ts';
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
