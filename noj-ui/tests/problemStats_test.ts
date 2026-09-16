// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals } from 'jsr:@std/assert@^1';
import {
  caseBarWidth,
  describeAcceptance,
  formatFirstAcMedian,
  type ProblemStatsDetail,
  sortedStatusDistribution,
  topFailedCases,
} from '../utils/problemStats.ts';

const baseDetail: ProblemStatsDetail = {
  attempt_count: 10,
  submit_count: 20,
  accepted_count: 6,
  acceptance_rate: 0.3,
  suppressed_reason: null,
  status_distribution: { finished: 18, error: 2 },
  case_failure_distribution: [
    { case_id: 'case-07', failed: 14, hidden: false },
    { case_id: 'hidden-1', failed: 9, hidden: true },
    { case_id: 'case-02', failed: 3, hidden: false },
  ],
  first_ac_median_ms: 12345,
  sample_size: 20,
  truncated: false,
  window_days: 90,
};

Deno.test('describeAcceptance: 区分赛中抑制、无提交与正常三种状态', () => {
  // 赛期：给出原因，而非显示 0%（否则会被误读为"没人做出来"）
  assertEquals(
    describeAcceptance({ ...baseDetail, acceptance_rate: null, suppressed_reason: 'running_contest' }),
    '竞赛进行中，暂不显示通过率',
  );
  // 无提交：占位
  assertEquals(
    describeAcceptance({
      ...baseDetail,
      submit_count: 0,
      accepted_count: 0,
      acceptance_rate: 0,
    }),
    '暂无通过记录',
  );
  // 正常：数值 + 分子分母
  assertEquals(
    describeAcceptance(baseDetail),
    '通过率 30.0% · 6/20',
  );
  // 未加载：null，调用方据此不渲染
  assertEquals(describeAcceptance(null), null);
  assertEquals(describeAcceptance(undefined), null);
});

Deno.test('describeAcceptance(C2): 赛期三项统计同为 null 时仍走「赛中抑制」分支', () => {
  // 后端赛期会把 accepted_count/submit_count/acceptance_rate 一并置 null
  // （只抑制 rate 会被除法还原）。此时必须先命中 suppressed 分支——若顺序错了，
  // `submit_count === 0` 为 false 而 `?? 0` 会把 null 当 0，渲染出
  // "通过率 0.0% · 0/0" 这类误导性文案。
  assertEquals(
    describeAcceptance({
      ...baseDetail,
      accepted_count: null,
      submit_count: null,
      acceptance_rate: null,
      suppressed_reason: 'running_contest',
    }),
    '竞赛进行中，暂不显示通过率',
  );
});

Deno.test('formatFirstAcMedian: 无数据用占位符而非 0s', () => {
  assertEquals(formatFirstAcMedian(null), '—');
  assertEquals(formatFirstAcMedian(12345), '12.3s');
  assertEquals(formatFirstAcMedian(0), '0.0s');
  assertEquals(formatFirstAcMedian(Number.NaN), '—');
});

Deno.test('sortedStatusDistribution: 按次数降序，便于看出主要失败原因', () => {
  assertEquals(sortedStatusDistribution({ error: 2, finished: 18 }), [
    ['finished', 18],
    ['error', 2],
  ]);
  assertEquals(sortedStatusDistribution({}), []);
});

Deno.test('topFailedCases: 限定条数且不修改入参', () => {
  const input = baseDetail.case_failure_distribution;
  assertEquals(topFailedCases(input, 2).length, 2);
  assertEquals(topFailedCases(input, 2)[0]?.case_id, 'case-07');
  // 排序不应被破坏
  assertEquals(input[0]?.case_id, 'case-07');
  assertEquals(topFailedCases(input).length, 3);
});

Deno.test('caseBarWidth: 最小可见宽度避免 1 次失败看起来像无数据', () => {
  const list = baseDetail.case_failure_distribution;
  assertEquals(caseBarWidth(14, list), '100%');
  // 3/14 ≈ 21%
  assertEquals(caseBarWidth(3, list), '21%');
  // 极小值仍有可见宽度
  assertEquals(caseBarWidth(0, list), '4%');
  assertEquals(caseBarWidth(5, []), '100%');
});
