import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, nextTick, reactive, ref, Suspense, watch } from 'vue';
import HubPage from '~/pages/d/[slug]/classrooms/index.vue';

const classrooms = vi.fn();
const dashboard = vi.fn();
const route = reactive({ path: '/d/school/classrooms', query: {} as Record<string, string> });
const replace = vi.fn();
let notifications: Array<() => Promise<void>>;

beforeEach(() => {
  vi.clearAllMocks();
  route.query = {};
  notifications = [];
  for (const [name, value] of Object.entries({ computed, reactive, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal('useRoute', () => route);
  vi.stubGlobal('useRouter', () => ({ replace, push: vi.fn() }));
  vi.stubGlobal('useState', () => ref({ id: 'coach' }));
  vi.stubGlobal(
    'useWorkspace',
    () => ({
      slug: ref('school'),
      domain: ref({ status: 'active', configuration: { features: { classroom: true, assignment: true } } }),
      can: (capability: string) => capability === 'classroom:create',
    }),
  );
  vi.stubGlobal('useEducationApi', () => ({ classrooms, dashboard }));
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal('usePolling', vi.fn());
  vi.stubGlobal('useEducationNotifications', (refresh: () => Promise<void>) => {
    notifications.push(refresh);
  });
  vi.stubGlobal('useAsyncData', async (_key: unknown, handler: () => Promise<unknown>) => {
    const data = ref<unknown>(null), error = ref<unknown>(null);
    const refresh = async () => {
      try {
        data.value = await handler();
        error.value = null;
      } catch (failure) {
        error.value = failure;
      }
    };
    await refresh();
    return { data, error, status: ref('success'), refresh };
  });
  classrooms.mockResolvedValue({ data: [], total: 0, per_page: 20 });
  dashboard.mockResolvedValue({
    data: { assignments: [], help_requests: [], total: 0, per_page: 20 },
  });
});

async function view() {
  const wrapper = mount(defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(HubPage) }) }), {
    global: {
      stubs: {
        UButton: { props: ['to'], template: '<a><slot /></a>' },
        LibraryPageHeader: true,
        UTabs: true,
        UBadge: { template: '<span><slot /></span>' },
        UAlert: true,
        UInput: true,
        USelect: true,
        UTextarea: true,
        UModal: true,
        UPagination: { props: ['total', 'itemsPerPage'], template: '<nav data-testid="pagination" />' },
        UIcon: true,
        NuxtLink: { props: ['to'], template: '<a><slot /></a>' },
        AdminPageHeader: true,
        AdminFormField: { template: '<label><slot /></label>' },
        AsyncContent: { props: ['error', 'emptyText'], template: '<div><slot /></div>' },
        ClassroomContests: true,
        ClientOnly: true,
      },
    },
  });
  await flushPromises();
  await nextTick();
  return wrapper;
}

describe('班级研练中心的持久事件刷新', () => {
  it('同时读取带班教学与我的学习大盘，并在教学事件后重读两者', async () => {
    const wrapper = await view();
    expect(dashboard).toHaveBeenCalledWith('school', 'teaching', 1);
    expect(dashboard).toHaveBeenCalledWith('school', 'my-learning', 1);
    dashboard.mockClear();
    await notifications[0]!();
    await flushPromises();
    expect(dashboard).toHaveBeenCalledWith('school', 'teaching', 1);
    expect(dashboard).toHaveBeenCalledWith('school', 'my-learning', 1);
    wrapper.unmount();
  });

  it('?view=learning 时仍以第一页读取学习大盘，教学页不再单独路由', async () => {
    route.query = { view: 'learning' };
    const wrapper = await view();
    expect(dashboard).toHaveBeenCalledWith('school', 'my-learning', 1);
    expect(wrapper.findAll('[data-testid="pagination"]').length).toBe(0);
    wrapper.unmount();
  });
});
