// deno-lint-ignore no-import-prefix
import { assertEquals } from 'jsr:@std/assert@^1';
import { domainUiSelfTestResult, domainUiSubmissionResult } from '../utils/domain-ui-runs.ts';
Deno.test('界面结果：hidden不读取隐藏分数、判定或output，只推送中性受理状态', () => {
  const record = {
    id: 's',
    status: 'finished',
    result_visibility: 'hidden' as const,
    result: { status: 'WA', score: 1234, output: 'secret' },
  };
  assertEquals(domainUiSubmissionResult(record), { kind: 'submit', status: 'accepted', label: '已受理', score: null });
});
Deno.test('界面结果：summary只推送汇总和统一换算分数，不传播details/output', () => {
  const record = {
    id: 's',
    status: 'finished',
    result_visibility: 'summary' as const,
    result: { status: 'accepted', score: 7500, details: { secret: true }, output: 'secret' },
  };
  const result = domainUiSubmissionResult(record);
  assertEquals(result.score, 75);
  assertEquals('output' in result, false);
  assertEquals('details' in result, false);
});
Deno.test('界面结果：排队阶段不显示已有分数，自测撤销资源后不推送output', () => {
  assertEquals(domainUiSubmissionResult({ status: 'pending', result: { status: 'pending', score: 9900 } }).score, null);
  assertEquals(
    domainUiSubmissionResult({ status: 'finished', result: { status: 'accepted', score: null } }).score,
    null,
  );
  const record = {
    status: 'finished',
    score: 5000,
    result_status: 'accepted',
    resource_available: false,
    output: 'old output',
  };
  assertEquals(domainUiSelfTestResult(record).score, 50);
  assertEquals('output' in domainUiSelfTestResult(record), false);
});
