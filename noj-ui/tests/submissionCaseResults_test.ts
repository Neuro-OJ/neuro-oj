/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals, assertExists } from 'jsr:@std/assert@^1';
import {
  isSubmissionCasePassed,
  normalizeSubmissionCases,
  submissionCasesWithProgress,
} from '../utils/submissionCaseResults.ts';

Deno.test('submissionCaseResults: 实时明细合并并发用例，完成结果优先于迟到的运行标记', () => {
  const rows = submissionCasesWithProgress(null, {
    phase: 'judging',
    completed_cases: [{ case_id: 'done', status: 'WA', score: 0, max_score: 5, time_ms: 8 }],
    active_cases: [
      { case_id: 'done', subtask_id: 'all' },
      { case_id: 'running_a', subtask_id: 'all' },
      { case_id: 'running_b', subtask_id: 'all' },
    ],
    total_cases: 5,
  });
  assertEquals(rows.map((item) => item.status), ['WA', 'RUNNING', 'RUNNING', 'PENDING', 'PENDING']);
  assertEquals(rows[0]?.score, 0);
  assertEquals(rows[0]?.timeMs, 8);
  assertEquals(rows.every((item) => item.visibility === 'hidden' && item.expectedOutput === null), true);
});

Deno.test('submissionCaseResults: 排队和编译期间显示待评测用例，终态使用正式明细', () => {
  const progress = { phase: 'compiling', completed_cases: [], active_cases: [], total_cases: 3 };
  assertEquals(submissionCasesWithProgress(null, progress).map((item) => item.status), [
    'PENDING',
    'PENDING',
    'PENDING',
  ]);
  const details = {
    oi: { subtasks: [{ cases: [{ case_id: 'done', status: 'AC' }, { case_id: 'skip', status: 'IGN' }] }] },
  };
  assertEquals(submissionCasesWithProgress(details, null), normalizeSubmissionCases(details));
});

Deno.test('submissionCaseResults: 归一化标准测试点并保留可见输出', () => {
  assertEquals(
    normalizeSubmissionCases({
      cases: [{
        case_id: 'v001',
        status: 'Accepted',
        visibility: 'visible',
        time_ms: 12,
        memory_kb: 256,
        input: '1 2',
        expected_output: '3',
        actual_output: '3',
      }],
    }),
    [{
      caseId: 'v001',
      status: 'Accepted',
      visibility: 'visible',
      timeMs: 12,
      memoryKb: 256,
      input: '1 2',
      expectedOutput: '3',
      actualOutput: '3',
    }],
  );
});

Deno.test('submissionCaseResults: 隐藏测试点清除所有敏感输出', () => {
  const [result] = normalizeSubmissionCases({
    cases: [{
      case_id: 'h001',
      status: 'WrongAnswer',
      visibility: 'hidden',
      time_ms: 8,
      input: 'secret input',
      expected_output: 'secret expected',
      actual_output: 'secret actual',
    }],
  });

  assertExists(result);
  assertEquals(result.visibility, 'hidden');
  assertEquals(result.timeMs, 8);
  assertEquals(result.input, null);
  assertEquals(result.expectedOutput, null);
  assertEquals(result.actualOutput, null);
});

Deno.test('submissionCaseResults: 兼容历史分组和旧字段名', () => {
  assertEquals(
    normalizeSubmissionCases({
      visible: {
        cases: [{ id: 'v001', status: 'PASS', expected: 3, actual: 3 }],
      },
      hidden: {
        cases: [{ id: 'h001', content_ok: true, expected: 4, actual: 4 }],
      },
    }),
    [
      {
        caseId: 'v001',
        status: 'PASS',
        visibility: 'visible',
        timeMs: null,
        memoryKb: null,
        input: null,
        expectedOutput: '3',
        actualOutput: '3',
      },
      {
        caseId: 'h001',
        status: 'Accepted',
        visibility: 'hidden',
        timeMs: null,
        memoryKb: null,
        input: null,
        expectedOutput: null,
        actualOutput: null,
      },
    ],
  );
});

Deno.test('submissionCaseResults: 忽略无法识别的详情', () => {
  assertEquals(
    normalizeSubmissionCases({
      cases: [null, {}, { case_id: 'missing-status' }],
    }),
    [],
  );
  assertEquals(normalizeSubmissionCases(null), []);
  assertEquals(normalizeSubmissionCases('invalid'), []);
});

Deno.test('submissionCaseResults: 兼容常见通过状态', () => {
  assertEquals(isSubmissionCasePassed('Accepted'), true);
  assertEquals(isSubmissionCasePassed('AC'), true);
  assertEquals(isSubmissionCasePassed('PASS'), true);
  assertEquals(isSubmissionCasePassed('WrongAnswer'), false);
});

Deno.test('submissionCaseResults: 展示 OI 子任务测试点但不泄露答案', () => {
  assertEquals(
    normalizeSubmissionCases({
      oi: {
        subtasks: [{
          id: 'basic',
          status: 'AC',
          cases: [{
            case_id: 'testdata/1.in',
            status: 'AC',
            time_ms: 4,
            memory_kb: 128,
          }],
        }],
      },
    }),
    [{
      caseId: 'testdata/1.in',
      status: 'AC',
      visibility: 'hidden',
      timeMs: 4,
      memoryKb: 128,
      input: null,
      expectedOutput: null,
      actualOutput: null,
    }],
  );
});
