import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, reactive, ref, Suspense, watch } from 'vue';

const mockToast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const mockDialog = vi.hoisted(() => ({ confirm: vi.fn() }));
const mockAdminApi = vi.hoisted(() => ({
  getSection: vi.fn(),
  updateSection: vi.fn(),
  domains: vi.fn(),
}));

vi.mock('~/composables/useToast', () => ({ useToast: () => ({ toast: mockToast }) }));

import AccessPage from '~/pages/admin/instance/access.vue';

const stubs = {
  AdminPageHeader: { template: '<div><slot name="actions" /></div>' },
  InstanceNav: { template: '<nav />' },
  AsyncContent: {
    props: ['status', 'error'],
    template: '<div><slot /></div>',
  },
  UCard: { template: '<div><slot /></div>' },
  USelect: {
    props: ['modelValue', 'items', 'ariaLabel'],
    emits: ['update:modelValue'],
    template: `
      <select :value="modelValue" :aria-label="ariaLabel" @change="$emit('update:modelValue', $event.target.value)">
        <option v-for="item in items" :key="item.value" :value="item.value">{{ item.label }}</option>
      </select>
    `,
  },
  USelectMenu: {
    props: ['modelValue', 'searchTerm', 'items', 'valueKey', 'ignoreFilter', 'ariaLabel'],
    emits: ['update:modelValue', 'update:searchTerm'],
    template: `
      <div data-testid="select-menu" :aria-label="ariaLabel">
        <input
          data-testid="search-input"
          :value="searchTerm"
          @input="$emit('update:searchTerm', $event.target.value)"
        />
        <select
          :value="modelValue"
          @change="$emit('update:modelValue', $event.target.value)"
        >
          <option v-for="item in items" :key="item.value || item" :value="item.value || item">
            {{ item.label || item }}
          </option>
        </select>
      </div>
    `,
  },
  UCheckbox: {
    props: ['modelValue', 'label'],
    emits: ['update:modelValue'],
    template:
      '<input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" />',
  },
  UAlert: { template: '<div role="alert"><slot /></div>' },
  UButton: {
    props: ['loading', 'disabled'],
    template: '<button :disabled="disabled"><slot /></button>',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('reactive', reactive);
  vi.stubGlobal('watch', watch);
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useUnsavedChanges', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal('useInstanceAdmin', () => mockAdminApi);
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'admin-1', role: 'admin' }) }));
  vi.stubGlobal('useDialog', () => ({ dialog: mockDialog }));

  mockAdminApi.getSection.mockResolvedValue({
    data: {
      revision: 'rev-access-1',
      values: {
        instance_access: 'public',
        instance_registration_mode: 'open',
        allow_domain_registration_invites: false,
        default_domain_slug: 'main',
      },
    },
  });

  mockAdminApi.domains.mockImplementation(({ keyword }: { keyword?: string }) => {
    if (keyword === 'school-73') {
      return Promise.resolve({
        data: [{ slug: 'school-73', name: '第73个空间', status: 'active' }],
      });
    }
    return Promise.resolve({
      data: [{ slug: 'main', name: '主空间', status: 'active' }],
    });
  });

  vi.stubGlobal('useAsyncData', (key: unknown, handler: () => Promise<unknown>, options?: { watch?: unknown[] }) => {
    const data = ref<unknown>(null);
    const status = ref('pending');
    const error = ref<unknown>(null);
    const refresh = async () => {
      status.value = 'pending';
      try {
        data.value = await handler();
        status.value = 'success';
      } catch (err) {
        error.value = err;
        status.value = 'error';
      }
    };

    if (typeof key === 'function') {
      watch(key as () => unknown, () => {
        void refresh();
      });
    } else if (key && typeof key === 'object' && 'value' in key) {
      watch(key as { value: unknown }, () => {
        void refresh();
      });
    }

    if (options?.watch) {
      for (const target of options.watch) {
        if (target) {
          watch(
            typeof target === 'function' ? (target as () => unknown) : () => (target as { value: unknown }).value,
            () => {
              void refresh();
            },
          );
        }
      }
    }

    const promise = refresh().then(() => ({ data, status, error, refresh }));
    return Object.assign(promise, { data, status, error, refresh });
  });
});

describe('实例访问与注册政策 - 默认工作空间搜索与选择', () => {
  it('默认域选择器为 USelectMenu，通过 searchTerm 触发服务端 keyword 查询并支持 fallback 显示', async () => {
    const TestComponent = defineComponent({
      render() {
        return h(Suspense, null, {
          default: () => h(AccessPage),
          fallback: () => h('div', 'Loading...'),
        });
      },
    });

    const wrapper = mount(TestComponent, {
      global: { stubs },
    });
    await flushPromises();

    // 初始加载：查全部 active 域（keyword 为 undefined）
    expect(mockAdminApi.domains).toHaveBeenCalledWith({
      page: 1,
      status: 'active',
      keyword: undefined,
    });

    const selectMenu = wrapper.find('[data-testid="select-menu"]');
    expect(selectMenu.exists()).toBe(true);
    expect(selectMenu.attributes('aria-label')).toBe('默认工作空间');

    // 触发 searchTerm 搜索第 73 个域
    const searchInput = selectMenu.get('[data-testid="search-input"]');
    await searchInput.setValue('school-73');
    await flushPromises();

    // 验证触发了 keyword 为 school-73 的 active 空间 API 查询
    expect(mockAdminApi.domains).toHaveBeenCalledWith({
      page: 1,
      status: 'active',
      keyword: 'school-73',
    });

    // 验证当前选择仍然包含当前已选默认域 main 的 fallback
    const options = selectMenu.findAll('option');
    const optionValues = options.map((opt) => (opt.element as HTMLOptionElement).value);
    expect(optionValues).toContain('school-73');
    expect(optionValues).toContain('main');

    // 选中新搜出的域并提交
    const select = selectMenu.get('select');
    await select.setValue('school-73');
    await flushPromises();

    mockAdminApi.updateSection.mockResolvedValue({
      data: { revision: 'rev-access-2' },
    });

    const form = wrapper.get('form');
    await form.trigger('submit');
    await flushPromises();

    expect(mockAdminApi.updateSection).toHaveBeenCalledWith(
      'access',
      expect.objectContaining({ default_domain_slug: 'school-73' }),
      'rev-access-1',
    );

    wrapper.unmount();
  });
});
