import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense, watch } from 'vue';
import CommunityIndex from '~/components/feature/community/CommunityIndex.vue';
vi.mock('~/composables/useToast', () => ({ useToast: () => ({ toast: { error: vi.fn() } }) }));
vi.mock('~/composables/useBanStatus', () => ({ useBanStatus: () => ({ userBanned: ref(false) }) }));
const get = vi.fn(), configError = ref<unknown>(null);
beforeEach(() => {
  vi.clearAllMocks();
  configError.value = null;
  for (const [name, value] of Object.entries({ ref, computed, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal(
    'useCommunityScope',
    () => ({
      capture: () => ({
        key: 'school',
        apiPath: (p: string) => `/school/${p}`,
        href: (p: string) => `/d/school/community/${p}`,
        isCurrent: () => true,
      }),
    }),
  );
  vi.stubGlobal('useAuth', () => ({ isLoggedIn: ref(false), user: ref(null) }));
  vi.stubGlobal('useRoute', () => ({ query: {}, fullPath: '/d/school/community' }));
  vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }));
  const config = ref({ enabled: true, discussions_enabled: true, solutions_enabled: true, permissions: {} });
  vi.stubGlobal('useCommunity', () => ({ config, error: configError, loadConfig: async () => config.value }));
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
  get.mockImplementation(async (path: string) =>
    path.endsWith('/counts') ? { data: {} } : { data: [], next_cursor: null }
  );
});
async function view() {
  const result = mount(
    defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(CommunityIndex) }) }),
    {
      global: {
        stubs: {
          UAlert: { props: ['title'], template: '<aside>{{ title }}<slot name="actions" /></aside>' },
          UButton: { template: '<button><slot /></button>' },
          UIcon: true,
        },
      },
    },
  );
  await flushPromises();
  return result;
}
describe('社区首屏失败与恢复', () => {
  it('列表故障显示真实错误，重试成功后才显示空态', async () => {
    get.mockRejectedValueOnce({ data: { error: '帖子服务暂不可用' }, statusCode: 503 });
    const result = await view();
    expect(result.text()).toContain('帖子服务暂不可用');
    expect(result.text()).not.toContain('还没有内容');
    await result.findAll('button').find((b) => b.text() === '重试加载社区')!.trigger('click');
    await flushPromises();
    expect(result.text()).toContain('还没有内容');
    expect(result.text()).not.toContain('帖子服务暂不可用');
    result.unmount();
  });
  it('配置读取失败不伪装成模块关闭，也不请求帖子', async () => {
    configError.value = { data: { error: '无法读取本域社区配置' }, statusCode: 503 };
    const result = await view();
    expect(result.text()).toContain('无法读取本域社区配置');
    expect(result.text()).not.toContain('社区功能暂未启用');
    expect(get).not.toHaveBeenCalled();
    result.unmount();
  });
});
