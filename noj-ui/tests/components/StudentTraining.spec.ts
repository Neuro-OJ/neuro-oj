import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense, watch } from 'vue';
import StudentTraining from '~/components/education/StudentTraining.vue';
import type { ClassroomDetail, TeachingCapability } from '~/utils/education';
const api = { studentSubmissions: vi.fn(), studentSubmission: vi.fn(), assignments: vi.fn() };
const stubs = {
  AdminPageHeader: { props: ['title'], template: '<h1>{{ title }}</h1>' },
  AsyncContent: { template: '<div><slot /></div>' },
  UAlert: { props: ['title', 'description'], template: '<p>{{ title }} {{ description }}</p>' },
  UButton: { template: '<button><slot /></button>' },
  USelect: true,
  UCard: { template: '<div><slot /></div>' },
  PaginationNav: true,
  USlideover: { template: '<div><slot name="body" /></div>' },
  SubmissionReview: true,
  ArtifactDownload: {
    props: ['endpoint', 'fileName'],
    template: '<button :data-endpoint="endpoint" :data-filename="fileName">下载原提交产物</button>',
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'assistant' }) }));
  vi.stubGlobal('useEducationApi', () => api);
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal(
    'useAsyncData',
    async (key: () => string, handler: () => Promise<unknown>) => {
      const data = ref(await handler());
      const refresh = async () => {
        data.value = await handler();
      };
      watch(key, refresh);
      return { data, status: ref('success'), error: ref(null), refresh };
    },
  );
  api.studentSubmissions.mockResolvedValue({
    data: {
      data: [{
        id: 's1',
        display_ref: 'main:1001',
        kind: 'submission',
        status: 'finished',
        accepted: false,
        score: null,
        created_at: '2026-10-13',
        verdict: null,
      }],
      total: 1,
      page: 1,
      per_page: 50,
    },
  });
  api.assignments.mockResolvedValue({ data: [] });
  api.studentSubmission.mockResolvedValue({
    data: {
      id: 's1',
      display_ref: 'main:1001',
      kind: 'submission',
      score: null,
      verdict: null,
      status: 'finished',
      has_artifact: true,
      file_name: 'answer.zip',
      time_ms: null,
      memory_kb: null,
    },
  });
});
async function view(capabilities: TeachingCapability[], historical = false) {
  const classroom = {
    id: 'c1',
    name: '班级',
    membership: { role: 'assistant', status: 'active' },
    manages_domain: false,
    capabilities,
  } as ClassroomDetail;
  const Wrapper = defineComponent({
    setup: () => () =>
      h(Suspense, null, {
        default: () =>
          h(StudentTraining, {
            slug: 'school',
            classroom,
            studentId: 'student',
            student: {
              id: 'member',
              user_id: 'student',
              username: '学生',
              role: 'student',
              status: historical ? 'removed' : 'active',
              effective_active: !historical,
            },
            writable: true,
          }),
      }),
  });
  const result = mount(Wrapper, { global: { stubs } });
  await flushPromises();
  return result;
}
describe('学生训练权限分别授权', () => {
  it('授权产物详情使用班级和使用域下载接口，不提供存储直链', async () => {
    const result = await view(['submissions:read']);
    await result.findAll('button').find((button) => button.text().includes('main:1001'))!.trigger('click');
    await flushPromises();
    expect(api.studentSubmission).toHaveBeenCalledWith('school', 'c1', 'submission', 's1');
    const download = result.findAll('button').find((button) => button.text() === '下载原提交产物')!;
    expect(download.attributes('data-endpoint')).toBe(
      '/api/v1/domains/school/classrooms/c1/submissions/submission/s1/artifact',
    );
    expect(download.attributes('data-filename')).toBe('answer.zip');
  });
  it('只有学情读取不请求学生提交或原代码详情', async () => {
    const result = await view(['progress:read']);
    expect(api.studentSubmissions).not.toHaveBeenCalled();
    expect(api.studentSubmission).not.toHaveBeenCalled();
    expect(api.assignments).toHaveBeenCalledWith('school', 'c1', 1);
    expect(result.text()).toContain('未授予学生提交读取能力');
  });
  it('只有提交读取可看同域记录，不请求学情任务，历史成员保留标记', async () => {
    const result = await view(['submissions:read'], true);
    expect(api.studentSubmissions).toHaveBeenCalledWith('school', 'c1', 'student', 1, undefined);
    expect(api.assignments).not.toHaveBeenCalled();
    expect(result.text()).toContain('历史学生记录');
    expect(result.text()).toContain('main:1001');
    expect(result.text()).toContain('暂无有效成绩');
    expect(result.text()).not.toContain('0 分');
  });
});
