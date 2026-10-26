import { describe, expect, it, vi } from 'vitest';
const requests = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('~/composables/useApi', () => ({ useApi: () => ({ api: requests }) }));
import { useEducationApi } from '~/composables/useEducation';
describe('教学同域提交路径', () => {
  it('学生分页列表和客观详情保留目标域、班级与提交类型', async () => {
    const education = useEducationApi();
    await education.studentSubmissions('school', 'class-one', 'student-one', 2, 'objective');
    await education.studentSubmission('school', 'class-one', 'objective', 'answer-one');
    expect(requests.get).toHaveBeenCalledWith(
      '/api/v1/domains/school/classrooms/class-one/students/student-one/submissions',
      { query: { page: 2, kind: 'objective' }, silent: true },
    );
    expect(requests.get).toHaveBeenCalledWith(
      '/api/v1/domains/school/classrooms/class-one/submissions/objective/answer-one',
      { silent: true },
    );
  });
});
