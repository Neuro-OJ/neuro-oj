import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense } from 'vue';
import HomeContent from '~/components/workspace/DomainHomeContent.vue';
const dashboard = vi.fn();
const domain = ref({ is_member: true, platform_admin: false, configuration: { features: { assignment: true } } });
beforeEach(() => {
  vi.clearAllMocks();
  domain.value.configuration.features.assignment = true;
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('useWorkspace', () => ({ slug: ref('school'), domain, can: () => true }));
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'coach' }) }));
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
  it('紧凑教学区只读取当前域授权任务，任务链接保留使用域', async () => {
    const result = await view();
    expect(dashboard).toHaveBeenCalledWith('school', 'teaching', 1);
    expect(result.text()).toContain('本班作业');
    expect(result.find('a[href="/d/school/assignments/assignment"]').exists()).toBe(true);
    result.unmount();
  });
  it('非教学域不显示教学区，也不读取教学接口', async () => {
    domain.value.configuration.features.assignment = false;
    const result = await view();
    expect(result.text()).not.toContain('教学与学习');
    expect(dashboard).not.toHaveBeenCalled();
    result.unmount();
  });
});
