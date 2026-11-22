import type { CoreReader } from './bff-request.ts';
import { BffError } from './bff-request.ts';
import type { ProblemSummaries } from '../../utils/problem-summaries.ts';
/** 固定当前使用域，单次最多50题；由 Core 集合授权并统一处理不可用题目。 */
export async function readProblemSummaries(
  reader: CoreReader,
  slug: string,
  references: string[],
): Promise<ProblemSummaries> {
  if (references.length === 0) return { items: [] };
  if (
    references.length > 50 ||
    references.some((reference) => !reference || reference.length > 128 || /[/.\\]/.test(reference))
  ) {
    throw new BffError(400, { error: '每次最多读取50个有效题号', code: 'BFF_INVALID_REFERENCES' });
  }
  const unique = [...new Set(references)];
  const response = await reader.post<{ data: ProblemSummaries }>(
    `/api/v1/domains/${encodeURIComponent(slug)}/problem-summaries`,
    { references: unique },
    { timeout: 2000 },
  );
  return response.data;
}
