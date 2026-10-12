/** utils/objectiveResult.ts 单元测试（VULN-03：竞赛模式不公布对错与精确分数）。 */
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  correctnessByQuestion,
  hasPendingObjectiveScore,
  OBJECTIVE_PENDING_HINT,
  OBJECTIVE_SCORE_PENDING_TEXT,
  objectiveScoreView,
  objectiveSubmissionScoreText,
} from '../utils/objectiveResult.ts';

Deno.test('correctnessByQuestion: 缺失 correct 的题目不入表（不得当成"回答错误"）', () => {
  const map = correctnessByQuestion({
    q1: { correct: true, given: ['A'] },
    // 竞赛进行中后端只返回 given：没有 correct 字段
    q2: { given: ['B'] },
    q3: { correct: false, given: ['C'] },
  });

  assertEquals(map.get('q1'), true);
  assertEquals(map.get('q3'), false);
  // 关键断言：q2 必须"不存在"，模板据 has() 决定不渲染徽标与颜色
  assertEquals(map.has('q2'), false);
  assertEquals(map.size, 2);
});

Deno.test('correctnessByQuestion: 空/缺省 details 不崩溃（竞赛提交回执 details 为 {}）', () => {
  assertEquals(correctnessByQuestion({}).size, 0);
  assertEquals(correctnessByQuestion(null).size, 0);
  assertEquals(correctnessByQuestion(undefined).size, 0);
});

Deno.test('objectiveScoreView: score 为 null 时不产出分数文案，改为待公布语义', () => {
  const pending = objectiveScoreView(null, null, 10);
  assertEquals(pending.pending, true);
  assertEquals(pending.text, null);
  assertEquals(OBJECTIVE_PENDING_HINT, '竞赛进行中，成绩与解析将在比赛结束后开放');
});

Deno.test('objectiveScoreView: 有分数时给出分数与正确题数（correct_count 缺失降级为占位）', () => {
  assertEquals(objectiveScoreView(100, 10, 10).text, '本次得分：100 分（10/10）');
  assertEquals(objectiveScoreView(0, 0, 5).text, '本次得分：0 分（0/5）');
  assertEquals(objectiveScoreView(80, null, 5).text, '本次得分：80 分（—/5）');
  assertEquals(objectiveScoreView(80, 4, 5).pending, false);
});

Deno.test('objectiveSubmissionScoreText: 历史列表 score 为 null 时不得调用 toFixed', () => {
  assertEquals(objectiveSubmissionScoreText(null), OBJECTIVE_SCORE_PENDING_TEXT);
  assertEquals(objectiveSubmissionScoreText(0), '0 分');
  assertEquals(objectiveSubmissionScoreText(8550), '86 分');
});

Deno.test('hasPendingObjectiveScore: 存在未公布成绩的提交时给出统一说明', () => {
  assertEquals(hasPendingObjectiveScore([{ score: null }]), true);
  assertEquals(hasPendingObjectiveScore([{ score: null }, { score: 8550 }]), true);
  assertEquals(hasPendingObjectiveScore([{ score: 8550 }]), false);
  assertEquals(hasPendingObjectiveScore([]), false);
});
