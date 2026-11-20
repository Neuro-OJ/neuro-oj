import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, reactive, ref, Suspense } from 'vue';
import ReportsPage from '~/pages/admin/reports.vue';
vi.mock('~/composables/useToast', () => ({ useToast: () => ({ toast: { success: vi.fn() } }) }));

const get = vi.fn();
const stubs = {
  AdminPageHeader: { template: '<header />' },
  UAlert: { props: ['title'], template: '<p role="alert">{{ title }}</p>' },
  UModal: { template: '<div />' },
  NuxtTime: { template: '<time />' },
  NuxtLink: { template: '<a><slot /></a>' },
  UButton: { template: '<button><slot /></button>' },
  UIcon: { template: '<span />' },
  AdminEditPanel: { template: '<div />' },
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ ref, reactive })) vi.stubGlobal(name, value);
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useApi', () => ({ api: { get } }));
  vi.stubGlobal('useDialog', () => ({ dialog: vi.fn() }));
});

describe('默认空间举报', () => {
  it('默认社区读取被拒绝时保留原因，三个状态分别读取', async () => {
    get.mockRejectedValue({ statusCode: 403, data: { error: '默认空间社区已停用' } });
    const Wrapper = defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(ReportsPage) }) });
    const view = mount(Wrapper, { global: { stubs } });
    await flushPromises();
    expect(view.get('[role="alert"]').text()).toBe('默认空间社区已停用');
    for (const status of ['pending', 'resolved', 'dismissed']) {
      expect(get).toHaveBeenCalledWith('/api/v1/admin/community/reports', {
        query: { status },
        silent: true,
      });
    }
  });
});
