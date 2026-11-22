// deno-lint-ignore no-import-prefix -- 沿用仓库固定断言库
import { assertEquals, assertRejects } from 'jsr:@std/assert@^1';
import { readProblemSummaries } from '../server/utils/bff-problem-summaries.ts';
import { BffError, type CoreReader } from '../server/utils/bff-request.ts';
Deno.test('题名摘要限制50题、固定使用域、去重并统一不可用结果', async () => {
  const calls: string[] = [];
  const reader: CoreReader = {
    get<T>(path: string): Promise<T> {
      calls.push(`GET ${path}`);
      return Promise.reject(new BffError(500, { error: '不应逐题读取' }));
    },
    post<T>(path: string, body: unknown): Promise<T> {
      calls.push(`POST ${path}`);
      const references = (body as { references: string[] }).references;
      return Promise.resolve({
        data: {
          items: references.map((reference) =>
            reference.endsWith('1002')
              ? {
                reference,
                availability: 'unavailable',
                title: null,
                kind: null,
                answer_version_id: null,
                answer_version: null,
                progress: null,
              }
              : {
                reference,
                availability: 'available',
                title: 'A+B',
                kind: 'oi',
                answer_version_id: 'version-1',
                answer_version: 1,
                progress: 'unseen',
              }
          ),
        },
      } as T);
    },
  };
  const data = await readProblemSummaries(reader, 'school', ['main:1001', 'main:1001', 'main:1002']);
  assertEquals(calls, ['POST /api/v1/domains/school/problem-summaries']);
  assertEquals(data.items, [{
    reference: 'main:1001',
    availability: 'available',
    title: 'A+B',
    kind: 'oi',
    answer_version_id: 'version-1',
    answer_version: 1,
    progress: 'unseen',
  }, {
    reference: 'main:1002',
    availability: 'unavailable',
    title: null,
    kind: null,
    answer_version_id: null,
    answer_version: null,
    progress: null,
  }]);
  await assertRejects(() => readProblemSummaries(reader, 'school', Array(51).fill('1001')), BffError);
  await assertRejects(() => readProblemSummaries(reader, 'school', ['../main']), BffError);
  reader.post = () => Promise.reject(new BffError(401, { error: '请登录' }));
  await assertRejects(() => readProblemSummaries(reader, 'school', ['1001']), BffError);
});
