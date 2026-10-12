// deno-lint-ignore no-import-prefix
import { assertEquals, assertNotEquals } from 'jsr:@std/assert@^1';
import { domainAnswerKey, domainProblemApiPath } from '../utils/domain-problems.ts';
Deno.test('共享题入口保留使用域及来源题号', () => {
  assertEquals(domainProblemApiPath('school', 'main:1001'), '/api/v1/domains/school/problems/main%3A1001');
});
Deno.test('同题不同账号、使用域、版本和语言保存独立草稿', () => {
  const base = domainAnswerKey('student', 'school', 'problem', 'v1', 'python3');
  for (
    const args of [
      ['other', 'school', 'problem', 'v1', 'python3'],
      ['student', 'main', 'problem', 'v1', 'python3'],
      ['student', 'school', 'problem', 'v2', 'python3'],
      ['student', 'school', 'problem', 'v1', 'cpp17'],
    ]
  ) assertNotEquals(base, domainAnswerKey(...args as [string, string, string, string, string]));
});
