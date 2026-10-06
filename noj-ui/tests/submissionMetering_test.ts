/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由锁文件固定
import { assertEquals } from 'jsr:@std/assert@^1';
import { submissionMeteringCases } from '../utils/submissionMetering.ts';

Deno.test('submissionMetering: 仅提取工作量字段，保留零值，不输出隐藏数据', () => {
  assertEquals(
    submissionMeteringCases({
      oi: {
        subtasks: [{
          id: 'all',
          cases: [{
            case_id: '1',
            status: 'AC',
            fuel_consumed: 0,
            fuel_budget: 1000000,
            equivalent_time_ms: 1,
            input: 'secret',
            expected_output: 'secret',
          }],
        }],
      },
    }),
    [{ subtask: 'all', caseId: '1', status: 'AC', fuel: 0, budget: 1000000, equivalentTimeMs: 1 }],
  );
});

Deno.test('submissionMetering: 缺失与非法统计显示为空，异常结构不崩溃', () => {
  for (const details of [null, {}, { oi: { subtasks: [null, { cases: 'invalid' }] } }]) {
    assertEquals(submissionMeteringCases(details), []);
  }
  assertEquals(
    submissionMeteringCases({
      oi: {
        subtasks: [{
          cases: [null, {
            fuel_consumed: -1,
            fuel_budget: Number.NaN,
            equivalent_time_ms: '1',
          }],
        }],
      },
    }),
    [{ subtask: '—', caseId: '测试点 2', status: '—', fuel: null, budget: null, equivalentTimeMs: null }],
  );
});
