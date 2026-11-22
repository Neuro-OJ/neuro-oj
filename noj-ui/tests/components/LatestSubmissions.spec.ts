import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense } from 'vue';
import LatestSubmissions from '~/components/feature/LatestSubmissions.vue';

const get = vi.fn();
let onEvent: Record<string, () => void> = {};

function activity(titles: string[]) {
  const snapshot = { total: titles.length, full_score: 0, not_full_score: titles.length };
  return {
    data: {
      recent: titles.map((title, i) => ({
        id: `s-${title}`,
        public_id: null,
        problem_id: `p-${i}`,
        status: 'finished',
        created_at: '2026-11-08T00:00:00.000Z',
        problem: { title },
        result: null,
      })),
      total: snapshot,
      today: snapshot,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  onEvent = {};
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('useApi', () => ({ api: { get } }));
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'u1' }) }));
  vi.stubGlobal('useEventSource', (options: { onEvent: Record<string, () => void> }) => {
    onEvent = options.onEvent;
    return { state: ref('connected') };
  });
  // 与 Nuxt 一致：`immediate: false` 时不发请求，data 保持 null，直到 refresh()。
  vi.stubGlobal(
    'useAsyncData',
    async (_key: unknown, read: () => Promise<unknown>, options?: { immediate?: boolean }) => {
      const data = ref<unknown>(null);
      const refresh = async () => {
        data.value = await read();
      };
      if (options?.immediate !== false) await refresh();
      return { data, error: ref(null), status: ref('success'), refresh };
    },
  );
});

async function mountWithInitial(initialData: ReturnType<typeof activity>) {
  const Host = defineComponent({
    render: () =>
      h(Suspense, null, {
        default: () => h(LatestSubmissions, { domainSlug: 'main', initialData }),
      }),
  });
  const wrapper = mount(Host, {
    global: {
      stubs: {
        UIcon: true,
        NuxtLink: { template: '<a><slot /></a>' },
        StatsToggle: true,
        AsyncContent: { template: '<div><slot /></div>' },
        SubmissionCard: {
          props: ['submission'],
          template: '<div class="card">{{ submission.problem.title }}</div>',
        },
      },
    },
  });
  await flushPromises();
  return wrapper;
}

describe('LatestSubmissions', () => {
  it('首屏使用服务端注入的初值，不重复请求', async () => {
    const wrapper = await mountWithInitial(activity(['旧题']));
    expect(get).not.toHaveBeenCalled();
    expect(wrapper.findAll('.card').map((c) => c.text())).toEqual(['旧题']);
  });

  it('收到 stats:updated 后显示刷新结果，而不是停在首屏数据', async () => {
    const wrapper = await mountWithInitial(activity(['旧题']));
    get.mockResolvedValue(activity(['新题', '旧题']));
    onEvent['stats:updated']();
    await flushPromises();
    expect(get).toHaveBeenCalledWith('/api/v1/domains/main/activity', { silent: true });
    expect(wrapper.findAll('.card').map((c) => c.text())).toEqual(['新题', '旧题']);
  });
});
