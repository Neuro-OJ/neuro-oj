import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense } from 'vue';
import DomainTrainingDetail from '~/pages/d/[slug]/trainings/[trainingId]/index.vue';
const resources = { sharing: vi.fn(), importProblem: vi.fn() }, detail = vi.fn();
const stubs = {
  AdminPageHeader: { template: '<div><slot name="actions" /></div>' },
  UCard: { template: '<div><slot /></div>' },
  AsyncContent: { template: '<div><slot /></div>' },
  MarkdownRenderer: true,
  UButton: { props: ['to', 'disabled'], template: '<button :data-to="to" :disabled="disabled"><slot /></button>' },
  UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal(
    'useRoute',
    () => ({
      params: { trainingId: 't1' },
      query: {},
      path: '/d/school/trainings/t1',
      fullPath: '/d/school/trainings/t1',
    }),
  );
  vi.stubGlobal('useWorkspace', () => ({ slug: ref('school'), domain: ref({ status: 'active' }) }));
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'student' }) }));
  vi.stubGlobal('useApi', () => ({
    api: {
      get: async () => {
        const response = await detail('school', 't1');
        const { items, ...training } = response.data;
        return {
          sections: {
            training: {
              data: {
                data: {
                  training,
                  page: 1,
                  per_page: 20,
                  total: items.length,
                  items: items.map((item: Record<string, unknown>) => ({
                    ...item,
                    title: '训练题目',
                    progress: 'unseen',
                    summary_error: false,
                  })),
                },
              },
            },
          },
        };
      },
    },
  }));
  vi.stubGlobal('useDomainResources', () => resources);
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal(
    'useAsyncData',
    async (_key: unknown, handler: () => Promise<unknown>) => ({
      data: ref(await handler()),
      status: ref('success'),
      error: ref(null),
      refresh: vi.fn(),
    }),
  );
});
async function page() {
  const Wrapper = defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(DomainTrainingDetail) }) });
  const view = mount(Wrapper, { global: { stubs } });
  await flushPromises();
  return view;
}
describe('引用题单的使用域作答', () => {
  it('学生只链接可用目标绑定，失效或未绑定题不跳来源域', async () => {
    detail.mockResolvedValue({
      data: {
        id: 't1',
        title: '源题单',
        description: '',
        can_share: false,
        can_edit: false,
        is_shared: true,
        source_domain_slug: 'main',
        items: [
          {
            problem_id: 'p1',
            display_ref: 'main:1001',
            qualified_ref: 'main:1001',
            binding_id: 'b1',
            resource_available: true,
            can_import: false,
            position: 0,
          },
          {
            problem_id: 'p2',
            display_ref: 'main:1002',
            qualified_ref: 'main:1002',
            binding_id: null,
            resource_available: false,
            can_import: false,
            position: 1,
          },
        ],
      },
    });
    const view = await page();
    const answers = view.findAll('button').filter((button) => button.text() === '继续作答');
    expect(answers).toHaveLength(1);
    expect(answers[0]!.attributes('data-to')).toBe('/d/school/problems/main:1001');
    expect(view.findAll('button').some((button) => button.text() === '引用题目到当前域')).toBe(false);
    expect(resources.sharing).not.toHaveBeenCalled();
    expect(detail).toHaveBeenCalledWith('school', 't1');
  });
  it('有导入能力的逐题按钮仍向当前使用域提交来源题号', async () => {
    detail.mockResolvedValue({
      data: {
        id: 't1',
        title: '源题单',
        can_share: false,
        can_edit: false,
        items: [{
          problem_id: 'p2',
          display_ref: 'main:1002',
          qualified_ref: 'main:1002',
          binding_id: null,
          resource_available: false,
          can_import: true,
          position: 0,
        }],
      },
    });
    resources.importProblem.mockResolvedValue({ data: { binding: { id: 'b2' } } });
    const view = await page();
    await view.findAll('button').find((button) => button.text() === '引用题目到当前域')!.trigger('click');
    await flushPromises();
    expect(resources.importProblem).toHaveBeenCalledWith('school', 'main:1002');
  });
});
