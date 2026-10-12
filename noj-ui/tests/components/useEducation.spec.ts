import { beforeEach, describe, expect, it, vi } from 'vitest';
const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('~/composables/useApi', () => ({ useApi: () => ({ api }) }));
import { useEducationApi } from '~/composables/useEducation';
beforeEach(() => vi.clearAllMocks());
describe('教学客户端契约', () => {
  it('发布和补题复制同时携带原 revision 与幂等键，保留目标学生和题目选择', () => {
    const education = useEducationApi();
    education.publish('school', 'task', 7, 'publish-key');
    expect(api.post).toHaveBeenCalledWith('/api/v1/domains/school/assignments/task/publish', {}, {
      headers: { 'If-Match': '7', 'Idempotency-Key': 'publish-key' },
    });
    const input = { title: '补题', target_student_ids: ['student'], item_ids: ['item'] };
    education.copy('school', 'task', 7, 'copy-key', input);
    expect(api.post).toHaveBeenCalledWith('/api/v1/domains/school/assignments/task/copy', input, {
      headers: { 'If-Match': '7', 'Idempotency-Key': 'copy-key' },
    });
  });
  it('助教能力只提交固定项，角色和成员变更使用班级 revision', () => {
    const education = useEducationApi();
    education.setMember('school', 'class', 'assistant', 'assistant', ['assignments:manage'], 4);
    expect(api.put).toHaveBeenCalledWith('/api/v1/domains/school/classrooms/class/members/assistant', {
      role: 'assistant',
      capabilities: ['assignments:manage'],
    }, { headers: { 'If-Match': '4' } });
    education.removeMember('school', 'class', 'student', 5);
    expect(api.delete).toHaveBeenCalledWith('/api/v1/domains/school/classrooms/class/members/student', {
      headers: { 'If-Match': '5' },
    });
  });
  it('同一源提交在两个学校使用明确路径，不回退默认域', () => {
    const education = useEducationApi();
    education.text('school-a', 'class-a', 'original', 'src/train.py');
    education.text('school-b', 'class-b', 'original', 'src/train.py');
    expect(api.get.mock.calls.map((c) => c[0])).toEqual([
      '/api/v1/domains/school-a/classrooms/class-a/submissions/submission/original/text',
      '/api/v1/domains/school-b/classrooms/class-b/submissions/submission/original/text',
    ]);
    expect(api.get.mock.calls[0]?.[1].query).toEqual({ file: 'src/train.py' });
  });
  it('批注提交保持原文本哈希、行范围和幂等键，不附加其他任务归属', () => {
    const input = { file_name: 'main.py', source_hash: 'a'.repeat(64), start_line: 2, end_line: 4, body: '检查边界' };
    useEducationApi().annotate('school', 'class', 'original', input, 'retry-key');
    expect(api.post).toHaveBeenCalledWith(
      '/api/v1/domains/school/classrooms/class/submissions/submission/original/annotations',
      input,
      { headers: { 'Idempotency-Key': 'retry-key' } },
    );
  });
  it('处理求助使用后端 PATCH 资源契约及当前 revision；CSV 继续携带原筛选范围', () => {
    const education = useEducationApi();
    education.resolve('school', 'task', 'help', 7);
    expect(api.patch).toHaveBeenCalledWith('/api/v1/domains/school/assignments/task/help-requests/help', {
      state: 'resolved',
    }, { headers: { 'If-Match': '7' } });
    education.csv('school', 'task', { scope: 'current', recipients: 'historical', status: 'below_target' });
    expect(api.get).toHaveBeenCalledWith('/api/v1/domains/school/assignments/task/matrix.csv', {
      query: { scope: 'current', recipients: 'historical', status: 'below_target' },
      responseType: 'text',
    });
  });
});
