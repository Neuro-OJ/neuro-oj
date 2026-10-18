// deno-lint-ignore no-import-prefix -- 沿用仓库固定断言库
import { assertEquals, assertRejects } from 'jsr:@std/assert@^1';
import { readProblemSummaries } from '../server/utils/bff-problem-summaries.ts';
import { BffError, type CoreReader } from '../server/utils/bff-request.ts';
Deno.test('题名摘要限制20题、固定使用域、去重并隔离资源失败', async () => {
  const calls: string[] = [];
  const reader: CoreReader = {
    get<T>(path: string): Promise<T> {
      calls.push(path);
      if (path.endsWith('1002')) return Promise.reject(new BffError(403, { error: '私有题名不得泄漏' }));
      return Promise.resolve({ content: { title: 'A+B', description: '不下发正文' } } as T);
    },
  };
  const data = await readProblemSummaries(reader, 'school', ['main:1001', 'main:1001', 'main:1002']);
  assertEquals(calls.length, 2);
  assertEquals(calls[0], '/api/v1/domains/school/problems/main%3A1001');
  assertEquals(data.items, [{ reference: 'main:1001', title: 'A+B', error: false }, {
    reference: 'main:1002',
    title: null,
    error: true,
  }]);
  await assertRejects(() => readProblemSummaries(reader, 'school', Array(21).fill('1001')), BffError);
  await assertRejects(() => readProblemSummaries(reader, 'school', ['../main']), BffError);
  reader.get = () => Promise.reject(new BffError(401, { error: '请登录' }));
  await assertRejects(() => readProblemSummaries(reader, 'school', ['1001']), BffError);
});
