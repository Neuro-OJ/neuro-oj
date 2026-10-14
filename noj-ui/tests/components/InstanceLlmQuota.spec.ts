import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, reactive, ref, watch } from 'vue';
const notices = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock('~/composables/useToast', () => ({ useToast: () => ({ toast: notices }) }));
import Quotas from '~/pages/admin/llm/quotas.vue';
const get = vi.fn(), post = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, reactive, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useRequireLogin', vi.fn());
  vi.stubGlobal('useAuth', () => ({ isLoggedIn: ref(true) }));
  vi.stubGlobal('useApi', () => ({ api: { get, post } }));
  get.mockResolvedValue({ data: [] });
  post.mockResolvedValue({ data: { id: 'created', revision: 1 } });
});
async function view() {
  const result = mount(Quotas, {
    global: {
      stubs: {
        AdminPageHeader: { template: '<header><slot name="actions" /></header>' },
        AdminTable: {
          props: ['items'],
          template:
            '<div><div v-for="row in items" class="test-row"><slot name="cell" :row="row" :column="{ key: \'max_calls\' }" /><slot name="cell" :row="row" :column="{ key: \'max_tokens\' }" /><slot name="actions" :row="row" /></div></div>',
        },
        AdminEditPanel: {
          props: ['open'],
          emits: ['save'],
          template: '<section v-if="open"><slot /><button @click="$emit(\'save\')">提交额度</button></section>',
        },
        UButton: { template: '<button><slot /></button>' },
        UIcon: true,
        USelect: {
          props: ['modelValue', 'items', 'disabled'],
          emits: ['update:modelValue'],
          template:
            '<select :value="modelValue" :disabled="disabled" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="item in items" :value="item.value">{{ item.label }}</option></select>',
        },
        UCheckbox: {
          props: ['modelValue', 'label'],
          emits: ['update:modelValue'],
          template:
            '<label>{{ label }}<input type="checkbox" :checked="modelValue" @change="$emit(\'update:modelValue\', $event.target.checked)" /></label>',
        },
      },
    },
  });
  await flushPromises();
  return result;
}
describe('实例总额度的新写入契约', () => {
  it('新建不限显式发送三个null及revision0，没有环境默认值暗示', async () => {
    const result = await view();
    await result.findAll('button').find((button) => button.text().includes('新增配额'))!.trigger('click');
    await result.findAll('button').find((button) => button.text() === '提交额度')!.trigger('click');
    await flushPromises();
    expect(post).toHaveBeenCalledWith('/api/v1/admin/gateway/llm/quotas', {
      scope_type: 'global',
      scope_id: '',
      window_type: 'day',
      max_calls: null,
      max_tokens: null,
      max_cost: null,
    }, { headers: { 'If-Match': '0' } });
    expect(result.text()).not.toContain('-1 不限');
  });
  it('旧负行编辑转null并使用原资源revision，负输入或超PG范围不会请求Gateway', async () => {
    get.mockResolvedValue({
      data: [{
        id: 'old',
        revision: 7,
        scope_type: 'global',
        scope_id: '',
        window_type: 'day',
        max_calls: -1,
        max_tokens: null,
        max_cost: 0,
        created_at: '',
        updated_at: '',
      }],
    });
    const result = await view();
    expect(result.get('.test-row').text()).toBe('不限不限');
    await result.get('button[aria-label="编辑"]').trigger('click');
    const limits = result.findAll('input[type="number"]');
    expect((limits[0]!.element as HTMLInputElement).disabled).toBe(true);
    expect(limits.every((input) => input.attributes('min') === '0' && input.attributes('max') === '2147483647')).toBe(
      true,
    );
    await result.findAll('button').find((button) => button.text() === '提交额度')!.trigger('click');
    await flushPromises();
    expect(post).toHaveBeenLastCalledWith(
      '/api/v1/admin/gateway/llm/quotas',
      expect.objectContaining({ id: 'old', max_calls: null, max_tokens: null }),
      { headers: { 'If-Match': '7' } },
    );
    await result.get('button[aria-label="编辑"]').trigger('click');
    await result.findAll('input[type="checkbox"]')[0]!.setValue(false);
    const input = result.findAll('input[type="number"]')[0]!;
    await input.setValue('-1');
    post.mockClear();
    await result.findAll('button').find((button) => button.text() === '提交额度')!.trigger('click');
    await flushPromises();
    expect(post).not.toHaveBeenCalled();
    expect(result.text()).toContain('0–2147483647');
    await input.setValue('2147483648');
    await result.findAll('button').find((button) => button.text() === '提交额度')!.trigger('click');
    await flushPromises();
    expect(post).not.toHaveBeenCalled();
  });
});
