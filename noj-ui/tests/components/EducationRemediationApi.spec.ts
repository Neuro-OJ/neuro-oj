import { describe, expect, it, vi } from 'vitest';
const requests = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('~/composables/useApi', () => ({ useApi: () => ({ api: requests }) }));
import { useEducationApi } from '~/composables/useEducation';
describe('补题预览与创建契约', () => {
  it('使用独立批量接口，创建明确附预览token、revision和幂等键', async () => {
    const api = useEducationApi();
    await api.remediationPreview('school', 'source-one', 'on_time');
    const body = {
      title: '补题',
      target_student_ids: ['last-page-student'],
      item_ids: ['item'],
      scope: 'on_time' as const,
      preview_token: 'fact-hash',
      deadline_at: null,
    };
    await api.createRemediation('school', 'source-one', 7, 'retry-key', body);
    expect(requests.post).toHaveBeenCalledWith(
      '/api/v1/domains/school/assignments/source-one/remediation-preview',
      { scope: 'on_time' },
      { silent: true },
    );
    expect(requests.post).toHaveBeenCalledWith(
      '/api/v1/domains/school/assignments/source-one/remediation',
      body,
      { headers: { 'If-Match': '7', 'Idempotency-Key': 'retry-key' }, silent: true },
    );
  });
});
