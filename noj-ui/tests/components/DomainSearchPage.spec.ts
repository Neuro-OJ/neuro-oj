import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, reactive, ref, Suspense, watch } from 'vue';
import SearchPage from '~/pages/d/[slug]/search.vue';
const search = vi.fn();
let route: { query: Record<string, string | number | undefined> };
beforeEach(() => {
  vi.clearAllMocks();
  route = reactive({ query: { q: '1001', type: 'problem' } });
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal('useRoute', () => route);
  vi.stubGlobal('useRouter', () => ({
    push: ({ query }: typeof route) => {
      route.query = query;
    },
  }));
  vi.stubGlobal('useWorkspace', () => ({ slug: ref('school') }));
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'student' }) }));
  vi.stubGlobal('useDomainQuery', () => ({ search }));
  vi.stubGlobal('useAsyncData', async (key: () => string, read: () => Promise<unknown>) => {
    const data = ref(await read());
    const refresh = async () => {
      data.value = await read();
    };
    watch(key, refresh);
    return { data, refresh, status: ref('success'), error: ref(null) };
  });
  search.mockResolvedValue({
    data: {
      items: [{
        entity_type: 'problem',
        entity_id: 'source',
        title: '加法',
        metadata: { reference: { display_ref: 'main:1001' } },
      }],
      has_more: true,
    },
  });
});
async function view() {
  const result = mount(defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(SearchPage) }) }), {
    global: {
      stubs: {
        AdminPageHeader: true,
        AsyncContent: { template: '<section><slot /></section>' },
        UButton: { template: '<button><slot /></button>' },
        NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
        UInput: {
          props: ['modelValue'],
          emits: ['update:modelValue'],
          template: '<input :value="modelValue" @input="$emit(\'update:modelValue\',$event.target.value)" />',
        },
        USelect: {
          props: ['modelValue', 'items'],
          emits: ['update:modelValue'],
          template:
            '<select :value="modelValue" @change="$emit(\'update:modelValue\',$event.target.value)"><option v-for="item in items" :value="item.value">{{ item.label }}</option></select>',
        },
      },
    },
  });
  await flushPromises();
  return result;
}
describe('显式域搜索与URL状态', () => {
  it('引用搜索结果在使用域打开，搜索及分页不读取其他域', async () => {
    const result = await view();
    expect(search).toHaveBeenCalledWith('school', '1001', 'problem', 1);
    expect(result.get('a').attributes('href')).toBe('/d/school/problems/main:1001');
    await result.findAll('button').find((b) => b.text() === '下一页')!.trigger('click');
    await flushPromises();
    expect(search).toHaveBeenLastCalledWith('school', '1001', 'problem', 2);
    await result.get('select').setValue('contest');
    await flushPromises();
    expect(search).toHaveBeenLastCalledWith('school', '1001', 'contest', 1);
    expect(route.query.type).toBe('contest');
    result.unmount();
  });
  it('搜索和浏览器返回以URL恢复关键词，短查询不发起搜索', async () => {
    const result = await view();
    await result.get('input').setValue('比赛');
    await result.get('form').trigger('submit');
    await flushPromises();
    expect(route.query.q).toBe('比赛');
    expect(search).toHaveBeenLastCalledWith('school', '比赛', 'problem', 1);
    route.query = { q: '1001', type: 'submission' };
    await flushPromises();
    expect((result.get('input').element as HTMLInputElement).value).toBe('1001');
    route.query = { q: 'a' };
    await flushPromises();
    const calls = search.mock.calls.length;
    await result.get('form').trigger('submit');
    await flushPromises();
    expect(search).toHaveBeenCalledTimes(calls);
    result.unmount();
  });
});
