import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, reactive, ref, Suspense } from 'vue';
import ReportsPage from '~/pages/admin/reports.vue';
vi.mock('~/composables/useToast', () => ({ useToast: () => ({ toast: { success: vi.fn() } }) }));

const get = vi.fn();
const stubs = {
  AdminPageHeader: { template: '<header />' },
  USelect: {
    props: ['modelValue', 'items'],
    emits: ['update:modelValue'],
    template:
      '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="item in items" :value="item.value">{{ item.label }}</option></select>',
  },
  UAlert: { props: ['title'], template: '<p role="alert">{{ title }}</p>' },
  UModal: { template: '<div />' },
  NuxtTime: { template: '<time />' },
  NuxtLink: { template: '<a><slot /></a>' },
  UButton: { template: '<button><slot /></button>' },
  UIcon: { template: '<span />' },
  AdminEditPanel: { template: '<div />' },
  AdminDetailDrawer: { template: '<div />' },
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ ref, reactive })) vi.stubGlobal(name, value);
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useApi', () => ({ api: { get } }));
  vi.stubGlobal('useDialog', () => ({ dialog: vi.fn() }));
});

describe('默认空间举报与独立私信筛选', () => {
  it('默认社区读取被拒绝时保留原因，选择私信使用明确账号范围', async () => {
    get.mockImplementation((_path: string, options: { query: { content_type?: string } }) =>
      options.query.content_type === 'message'
        ? Promise.resolve({ data: [] })
        : Promise.reject({ statusCode: 403, data: { error: '默认空间社区已停用' } })
    );
    const Wrapper = defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(ReportsPage) }) });
    const view = mount(Wrapper, { global: { stubs } });
    await flushPromises();
    expect(view.get('[role="alert"]').text()).toBe('默认空间社区已停用');
    await view.get('select').setValue('message');
    await flushPromises();
    expect(view.find('[role="alert"]').exists()).toBe(false);
    expect(view.text()).toContain('暂无待处理举报');
    for (const status of ['pending', 'resolved', 'dismissed']) {
      expect(get).toHaveBeenCalledWith('/api/v1/admin/community/reports', {
        query: { status, content_type: 'message' },
        silent: true,
      });
    }
  });
});
