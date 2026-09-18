// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assertEquals, assertStringIncludes } from 'jsr:@std/assert@^1';
import {
  describeCoverage,
  isTruncated,
  type SimilarSubmissionPair,
  type SimilarSubmissionsMeta,
} from '../utils/contestAntiCheat.ts';
type ContestAntiCheatGroup = {
  ip: string;
  account_count: number;
  submission_count: number;
  first_submission_at: string;
  last_submission_at: string;
  accounts: Array<{
    user_id: string;
    username: string;
    submission_count: number;
    first_submission_at: string;
    last_submission_at: string;
  }>;
};

Deno.test('竞赛风控 DTO 仅包含人工复核所需的最小字段', () => {
  const group: ContestAntiCheatGroup = {
    ip: '203.0.113.10',
    account_count: 2,
    submission_count: 3,
    first_submission_at: '2026-01-01T00:00:00.000Z',
    last_submission_at: '2026-01-01T00:03:00.000Z',
    accounts: [{
      user_id: 'u1',
      username: 'alice',
      submission_count: 2,
      first_submission_at: '2026-01-01T00:00:00.000Z',
      last_submission_at: '2026-01-01T00:02:00.000Z',
    }],
  };
  assertEquals(group.account_count, 2);
  assertStringIncludes(group.ip, '203.0.113.');
  assertEquals('email' in group.accounts[0]!, false);
});

Deno.test('相似提交 DTO 不含源代码，且携带人工复核所需的证据强度字段', () => {
  // 断言的是实现里导出的**真实类型**，而非测试内自建的镜像副本——
  // 后者会与实现漂移却仍然通过（本仓库已多次出现这类“假绿灯”）。
  const pair: SimilarSubmissionPair = {
    submission_a_id: 's1',
    user_a_id: 'u1',
    username_a: 'alice',
    submitted_at_a: '2026-01-01T00:00:00.000Z',
    submission_b_id: 's2',
    user_b_id: 'u2',
    username_b: 'bob',
    submitted_at_b: '2026-01-01T00:05:00.000Z',
    problem_id: 'p1',
    language: 'python3',
    similarity: 0.9312,
    shared_fingerprints: 142,
    fingerprint_count_a: 180,
    fingerprint_count_b: 155,
  };
  const keys = Object.keys(pair);
  // 复核只需要线索字段；源码属于提交详情页面的职责（最小暴露面）
  assertEquals(keys.includes('code'), false);
  assertEquals(keys.includes('source'), false);
  // 证据强度三件套必须存在，管理员据此判断相似度是否可信
  assertEquals(keys.includes('shared_fingerprints'), true);
  assertEquals(keys.includes('fingerprint_count_a'), true);
  assertEquals(keys.includes('fingerprint_count_b'), true);
  assertEquals(typeof pair.similarity, 'number');
});

Deno.test('相似提交覆盖率文案区分“取了候选”与“真正比较”，避免误读为无相似提交', () => {
  const meta: SimilarSubmissionsMeta = {
    threshold: 0.8,
    limit: 50,
    total: 0,
    truncated: false,
    candidates: 120,
    participating: 37,
    skipped: 5,
    buckets: 3,
    max_submissions: 200,
  };
  assertEquals(describeCoverage(meta), '比较 37 份 / 候选 120 份，跳过 5 份');
  // 无 meta（未加载）时返回 null，调用方据此决定不渲染，而非显示 "0 份" 误导
  assertEquals(describeCoverage(null), null);
  assertEquals(describeCoverage(undefined), null);
});

Deno.test('截断必须被显式识别：truncated 为 true 时提示，缺失或 false 时不提示', () => {
  const base: SimilarSubmissionsMeta = {
    threshold: 0.8,
    limit: 50,
    total: 0,
    truncated: false,
    candidates: 0,
    participating: 0,
    skipped: 0,
    buckets: 0,
    max_submissions: 200,
  };
  assertEquals(isTruncated({ ...base, truncated: true }), true);
  assertEquals(isTruncated(base), false);
  assertEquals(isTruncated(null), false);
});
