import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense, watch } from 'vue';
import DomainProblemVersions from '~/components/feature/DomainProblemVersions.vue';
const versions = vi.fn();
const stubs = {
  UCard: { template: '<div><slot /></div>' },
  UButton: { template: '<button><slot /></button>' },
  UBadge: { template: '<span><slot /></span>' },
  AsyncContent: {
    props: ['status', 'error'],
    template: '<p v-if="status === \'error\'">{{ error }}</p><div v-else><slot /></div>',
  },
  UPagination: { template: '<div />' },
};
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'student' }) }));
  vi.stubGlobal('useDomainProblems', () => ({ versions }));
  vi.stubGlobal('useAsyncData', async (_key: unknown, load: () => Promise<unknown>) => {
    try {
      return { data: ref(await load()), error: ref(null), status: ref('success'), refresh: vi.fn() };
    } catch (error) {
      return { data: ref(null), error: ref(error), status: ref('error'), refresh: vi.fn() };
    }
  });
});
async function history() {
  const Wrapper = defineComponent({
    setup: () => () =>
      h(Suspense, null, { default: () => h(DomainProblemVersions, { slug: 'school', reference: 'main:1001' }) }),
  });
  const view = mount(Wrapper, { global: { stubs } });
  await flushPromises();
  return view;
}
describe('目标域题目版本沿革', () => {
  it('按使用域来源题号读取元数据，标记域策略选择的版本而非最高版本', async () => {
    versions.mockResolvedValue({
      items: [{ version_id: 'v2', version: 2, change_note: '新版说明', published_at: '2026-10-13' }, {
        version_id: 'v1',
        version: 1,
        change_note: '旧版说明',
        published_at: '2026-10-12',
      }],
      answer_version_id: 'v1',
      total: 2,
      limit: 20,
    });
    const view = await history();
    expect(versions).toHaveBeenCalledWith('school', 'main:1001', 1);
    expect(view.findAll('li')[1]!.text()).toContain('当前作答版本');
    expect(view.findAll('li')[0]!.text()).not.toContain('当前作答版本');
  });
  it('源授权撤销时显示读取错误，不展示历史内容或返回源域入口', async () => {
    versions.mockRejectedValue({ statusCode: 404, data: { error: '题目不可访问' } });
    const view = await history();
    expect(view.text()).toContain('题目不可访问');
    expect(view.findAll('li')).toHaveLength(0);
  });
});
