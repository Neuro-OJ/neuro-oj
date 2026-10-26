import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, onUnmounted, reactive, ref, Suspense, watch } from 'vue';
import ProblemList from '~/pages/d/[slug]/problems/index.vue';
import ProblemFilterBar from '~/components/feature/ProblemFilterBar.vue';
import { useProblemFilters } from '~/composables/useProblemFilters';
const list = vi.fn();
let route: { query: Record<string, string> };
beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, watch, onUnmounted })) vi.stubGlobal(name, value);
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal('useWorkspace', () => ({ slug: ref('school'), can: () => false, domain: ref({ status: 'active' }) }));
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'student' }) }));
  vi.stubGlobal('useDomainProblems', () => ({ list }));
  route = reactive({ query: {} });
  vi.stubGlobal('useRoute', () => route);
  vi.stubGlobal('useRouter', () => ({
    push: ({ query }: typeof route) => {
      route.query = query;
    },
  }));
  vi.stubGlobal('useProblemFilters', useProblemFilters);
  vi.stubGlobal('useAsyncData', async (key: { value: string }, read: () => Promise<unknown>) => {
    const data = ref(await read());
    const refresh = async () => {
      data.value = await read();
    };
    watch(key, refresh);
    return { data, refresh, status: ref('success'), error: ref(null) };
  });
  list.mockResolvedValue({
    items: [{
      binding_id: 'b1',
      title: '共享加法',
      reference: { display_ref: 'main:1001' },
      kind: 'oi',
      version: 1,
      difficulty: 'easy',
      progress: 'solved',
      valid_submissions: 4,
      accepted_submissions: 2,
      tags: [{ id: 'topic', name: '数学', kind: 'problem' }],
    }],
    total: 61,
  });
});
async function view() {
  const input = {
    props: ['modelValue'],
    emits: ['update:modelValue'],
    template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  };
  const result = mount(defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(ProblemList) }) }), {
    global: {
      components: { ProblemFilterBar },
      stubs: {
        UCard: { template: '<div><slot /></div>' },
        UFormField: { template: '<label><slot /></label>' },
        UTable: {
          props: ['data', 'columns'],
          template:
            '<table><tbody><tr v-for="item in data"><td v-for="column in columns"><slot :name="column.accessorKey + \'-cell\'" :row="{original:item}" /></td></tr></tbody></table>',
        },
        PaginationNav: {
          props: ['currentPage', 'totalPages'],
          emits: ['page-change'],
          template: '<button @click="$emit(\'page-change\',currentPage+1)">下一页</button>',
        },
        AsyncContent: { template: '<section><slot /></section>' },
        NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
        UInput: input,
        UButton: { template: '<button><slot /></button>' },
        UBadge: { template: '<span><slot /></span>' },
        DifficultyBadge: { props: ['difficulty'], template: '<span>{{ difficulty }}</span>' },
        USelect: {
          props: ['modelValue', 'items'],
          emits: ['update:modelValue'],
          template:
            '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="item in items" :value="item.value">{{ item.label }}</option></select>',
        },
      },
    },
  });
  await flushPromises();
  return result;
}
describe('域题库列表与筛选', () => {
  it('显示本人状态、难度、有效通过率与标签，引用链接保留使用域', async () => {
    const result = await view();
    expect(result.text()).toContain('已通过');
    expect(result.text()).toContain('50.0%');
    expect(result.get('a').attributes('href')).toBe('/d/school/problems/main:1001');
    await result.findAll('button').find((button) => button.text() === '数学')!.trigger('click');
    await flushPromises();
    expect(list).toHaveBeenLastCalledWith('school', 1, '', expect.objectContaining({ tag_id: 'topic' }));
    result.unmount();
  });
  it('题号搜索与筛选均传给本域接口，修改筛选重置页码', async () => {
    const result = await view();
    await result.get('input[aria-label="搜索题目"]').setValue('main:1001');
    await result.get('form').trigger('submit');
    await flushPromises();
    await result.findAll('button').find((button) => button.text() === '下一页')!.trigger('click');
    await flushPromises();
    expect(list).toHaveBeenLastCalledWith('school', 2, 'main:1001', expect.anything());
    await result.get('select[aria-label="筛选本人状态"]').setValue('unseen');
    await flushPromises();
    expect(list).toHaveBeenLastCalledWith('school', 1, 'main:1001', expect.objectContaining({ progress: 'unseen' }));
    result.unmount();
  });
});
