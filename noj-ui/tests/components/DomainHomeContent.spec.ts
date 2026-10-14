import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense } from 'vue';
import HomeContent from '~/components/workspace/DomainHomeContent.vue';
const get = vi.fn(), problems = vi.fn(), contests = vi.fn(), dashboard = vi.fn();
const domain = ref({ is_member: true, platform_admin: false, configuration: { features: { assignment: true } } });
beforeEach(() => {
  vi.clearAllMocks();
  domain.value.configuration.features.assignment = true;
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('useWorkspace', () => ({ slug: ref('school'), domain, can: () => true }));
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'coach' }) }));
  vi.stubGlobal('useApi', () => ({ api: { get } }));
  vi.stubGlobal('useDomainProblems', () => ({ list: problems }));
  vi.stubGlobal('useDomainContests', () => ({ list: contests }));
  vi.stubGlobal('useEducationApi', () => ({ dashboard }));
  vi.stubGlobal('useEducationNotifications', vi.fn());
  vi.stubGlobal('useAsyncData', async (_key: unknown, read: () => Promise<unknown>) => {
    const data = ref<unknown>(null), error = ref<unknown>(null);
    const refresh = async () => {
      try {
        data.value = await read();
        error.value = null;
      } catch (e) {
        error.value = e;
      }
    };
    await refresh();
    return { data, error, status: ref('success'), refresh };
  });
  get.mockResolvedValue({ data: { problems: 5, users: 40, submissions: 12, accepted: 8 } });
  problems.mockResolvedValue({ items: [{ binding_id: 'b1', title: '加法', reference: { display_ref: 'main:1001' } }] });
  contests.mockResolvedValue({ data: [] });
  dashboard.mockResolvedValue({
    data: {
      assignments: [{
        id: 'assignment',
        title: '本班作业',
        classroom_name: '一班',
        summary: { updating: false, unavailable_items: 0 },
      }],
    },
  });
});
async function view() {
  const result = mount(defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(HomeContent) }) }), {
    global: {
      stubs: {
        UCard: { template: '<section><slot /></section>' },
        UButton: { template: '<button><slot /></button>' },
        UAlert: true,
        USelect: true,
        AsyncContent: { props: ['error', 'emptyText'], template: '<div>{{ error }}<slot /></div>' },
        NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
      },
    },
  });
  await flushPromises();
  return result;
}
describe('域首页的实际内容', () => {
  it('统计、题目、比赛与教学分别读取当前域，引用链接不改变使用域', async () => {
    const result = await view();
    expect(get).toHaveBeenCalledWith('/api/v1/domains/school/stats', { silent: true });
    expect(problems).toHaveBeenCalledWith('school', 1);
    expect(contests).toHaveBeenCalledWith('school', 1);
    expect(dashboard).toHaveBeenCalledWith('school', 'teaching', 1);
    expect(result.text()).toContain('本班作业');
    expect(result.text()).toContain('域内成员');
    expect(result.find('a[href="/d/school/problems/main:1001"]').exists()).toBe(true);
    result.unmount();
  });
  it('题库失败显示错误但不阻断教学；非教学类型不读取教学接口', async () => {
    domain.value.configuration.features.assignment = false;
    problems.mockRejectedValue({ data: { error: '题库暂不可用' } });
    const result = await view();
    expect(result.text()).toContain('题库暂不可用');
    expect(result.text()).toContain('域内成员');
    expect(dashboard).not.toHaveBeenCalled();
    result.unmount();
  });
});
