/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix
import { assertEquals } from 'jsr:@std/assert@^1';
import { originalAnswerText, ownHistoryDetailLink, ownHistoryProblemLink } from '../utils/own-submissions.ts';
import type { OwnSubmissionHistory } from '../utils/own-submissions.ts';
const entry = {
  kind: 'objective',
  id: 'answer-one',
  domain: { slug: 'school', accessible: true },
  resource_available: true,
  reference: { display_ref: 'main:1001' },
} as OwnSubmissionHistory;
Deno.test('本人跨域历史：失去域或源资源授权均不生成题目入口，原记录入口保留', () => {
  assertEquals(ownHistoryProblemLink(entry), '/d/school/problems/main:1001');
  assertEquals(ownHistoryProblemLink({ ...entry, domain: { ...entry.domain, accessible: false } }), undefined);
  assertEquals(ownHistoryProblemLink({ ...entry, resource_available: false }), undefined);
  assertEquals(ownHistoryDetailLink(entry), '/my/submissions/objective/answer-one');
});
Deno.test('本人原回答：判断选择不冒充评测正确性，保留空回答', () => {
  assertEquals(originalAnswerText([true, 'A']), '选择“对”、A');
  assertEquals(originalAnswerText(false), '选择“错”');
  assertEquals(originalAnswerText([]), '未作答');
});
