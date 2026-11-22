/**
 * 题解关联题目搜索：必须按本次输入的新值触发。
 *
 * 回归背景（评审 P2）：Nuxt UI 4.10 的 UInput 会先透传原生 `input` 事件、
 * 再更新 v-model。组件此前用 `@input="searchProblems"` 并在 handler 里读
 * `problemQuery`，读到的是上一次的值：输入 "ab" 后补 "c" 时两次分别读到 ""
 * 和 "ab"，粘贴两个字符还会因长度检查跳过搜索。下面的 UInput 替身按同样顺序
 * 先发 `input`、再发 `update:modelValue`，锁住"删除/粘贴/逐字输入"三条路径。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense, watch } from 'vue';
import CommunityIndex from '~/components/community/CommunityIndex.vue';

vi.mock('~/composables/useToast', () => ({ useToast: () => ({ toast: { error: vi.fn() } }) }));
vi.mock('~/composables/useBanStatus', () => ({ useBanStatus: () => ({ userBanned: ref(false) }) }));

const get = vi.fn();

/** 复刻 Nuxt UI UInput 的事件顺序：先透传 input，再更新 v-model。 */
const UInputStub = defineComponent({
  props: { modelValue: { type: String, default: '' } },
  emits: ['update:modelValue', 'input', 'focus', 'blur'],
  template:
    `<input :value="modelValue" @input="$emit('input', $event); $emit('update:modelValue', $event.target.value)" @focus="$emit('focus')" @blur="$emit('blur')" />`,
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ ref, computed, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal(
    'useCommunityScope',
    () => ({
      capture: () => ({
        slug: 'school',
        key: 'school',
        apiPath: (p: string) => `/api/v1/domains/school/community/${p}`,
        href: (p: string) => `/d/school/community/${p}`,
        isCurrent: () => true,
      }),
    }),
  );
  vi.stubGlobal('useAuth', () => ({ isLoggedIn: ref(true), user: ref({ id: 'u1' }) }));
  vi.stubGlobal('useRoute', () => ({ query: {}, fullPath: '/d/school/community' }));
  vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }));
  const config = ref({
    enabled: true,
    discussions_enabled: true,
    solutions_enabled: true,
    read_only: false,
    under_review: false,
    contest_silence: false,
    post_max_length: 20000,
    permissions: { solution: true, discussion: true },
  });
  vi.stubGlobal(
    'useCommunity',
    () => ({ config, error: ref(null), loadConfig: () => Promise.resolve(config.value) }),
  );
  vi.stubGlobal('useDialog', () => ({ dialog: {} }));
  vi.stubGlobal('useReportModal', () => ({ open: vi.fn() }));
  vi.stubGlobal('useApi', () => ({ api: { get } }));
  vi.stubGlobal('useAsyncData', async (_key: string, load: () => Promise<unknown>) => {
    const data = ref<unknown>(null), error = ref<unknown>(null), status = ref('pending');
    const refresh = async () => {
      try {
        data.value = await load();
        error.value = null;
        status.value = 'success';
      } catch (e) {
        error.value = e;
        status.value = 'error';
      }
    };
    await refresh();
    return { data, error, status, refresh };
  });
  get.mockImplementation((path: string) => {
    if (path.endsWith('/counts')) return Promise.resolve({ data: {} });
    if (path.includes('/search')) return Promise.resolve({ data: { items: [] } });
    return Promise.resolve({ data: [], next_cursor: null });
  });
});

/** 搜索接口的 q 参数序列（按调用顺序）。 */
function searchQueries(): string[] {
  return get.mock.calls
    .filter(([path]) => String(path).includes('/search'))
    .map(([, options]) => (options as { query: { q: string } }).query.q);
}

async function openSolutionEditor() {
  const result = mount(
    defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(CommunityIndex) }) }),
    {
      global: {
        stubs: {
          UAlert: { props: ['title'], template: '<aside>{{ title }}<slot name="actions" /></aside>' },
          UButton: { template: '<button><slot /></button>' },
          UInput: UInputStub,
          UTextarea: { props: ['modelValue'], template: '<textarea :value="modelValue"></textarea>' },
          UIcon: true,
        },
      },
    },
  );
  await flushPromises();
  const tab = result.findAll('button').find((b) => b.text() === '题解')!;
  await tab.trigger('click');
  await flushPromises();
  const publish = result.findAll('button').find((b) => b.text() === '发布内容')!;
  await publish.trigger('click');
  await flushPromises();
  return result;
}

describe('题解关联题目搜索按新值触发', () => {
  it('逐字输入时使用本次事件的新值（不是上一次的 modelValue）', async () => {
    const result = await openSolutionEditor();
    const input = result.find('input[placeholder^="搜索题目"]');

    // 第一次输入 1 个字符：新值长度不足，不发请求（旧实现同样不发）。
    await input.setValue('a');
    await flushPromises();
    expect(searchQueries()).toEqual([]);

    // 补到 2 个字符：必须立刻用 "ab" 搜索。
    // 旧实现此时读到的是上一次的 "a"，仍不搜索。
    await input.setValue('ab');
    await flushPromises();
    expect(searchQueries()).toEqual(['ab']);
    result.unmount();
  });

  it('粘贴多个字符时按完整粘贴内容搜索', async () => {
    const result = await openSolutionEditor();
    const input = result.find('input[placeholder^="搜索题目"]');

    // 单个 input 事件带入 2 个字符（粘贴）：长度检查必须看新值。
    // 旧实现读到空字符串，直接跳过搜索。
    await input.setValue('ab');
    await flushPromises();
    expect(searchQueries()).toEqual(['ab']);
    result.unmount();
  });

  it('删除字符时按删除后的内容搜索，删到 1 个字符则关闭下拉', async () => {
    const result = await openSolutionEditor();
    const input = result.find('input[placeholder^="搜索题目"]');

    await input.setValue('abc');
    await flushPromises();
    expect(searchQueries()).toEqual(['abc']);

    // 删除一个字符：必须搜索 "ab"，而不是上一次的 "abc"。
    await input.setValue('ab');
    await flushPromises();
    expect(searchQueries()).toEqual(['abc', 'ab']);

    // 继续删到 1 个字符：关闭下拉、不再发请求（不能拿旧的 "ab" 继续搜）。
    await input.setValue('a');
    await flushPromises();
    expect(searchQueries()).toEqual(['abc', 'ab']);
    expect(result.text()).not.toContain('无匹配题目');
    result.unmount();
  });
});
