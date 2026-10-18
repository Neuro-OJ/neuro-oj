import type { CoreReader } from './bff-request.ts';
import { BffError } from './bff-request.ts';
import type { DomainProblemDetail } from '../../utils/domain-problems.ts';
import type { ProblemSummaries } from '../../utils/problem-summaries.ts';
/** 固定当前使用域，单次最多20题；单题失败不暴露上游诊断或越权题名。 */
export async function readProblemSummaries(
  reader: CoreReader,
  slug: string,
  references: string[],
): Promise<ProblemSummaries> {
  if (
    references.length > 20 ||
    references.some((reference) => !reference || reference.length > 128 || /[/.\\]/.test(reference))
  ) {
    throw new BffError(400, { error: '每次最多读取20个有效题号', code: 'BFF_INVALID_REFERENCES' });
  }
  return {
    items: await Promise.all([...new Set(references)].map(async (reference) => {
      try {
        const problem = await reader.get<DomainProblemDetail>(
          `/api/v1/domains/${encodeURIComponent(slug)}/problems/${encodeURIComponent(reference)}`,
          { timeout: 2000 },
        );
        return { reference, title: problem.content.title, error: false };
      } catch (error) {
        if (!(error instanceof BffError) || error.statusCode === 401) throw error;
        return { reference, title: null, error: true };
      }
    })),
  };
}
