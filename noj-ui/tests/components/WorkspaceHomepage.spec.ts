import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, reactive, ref, watch } from 'vue';
import type { WorkspaceDetail } from '~/utils/workspace';
const notices = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock('~/composables/useToast', () => ({ useToast: () => ({ toast: notices }) }));
import WorkspaceHome from '~/pages/d/[slug]/index.vue';
const navigate = vi.fn(), route = reactive({ path: '/d/school' });
const domain = ref<WorkspaceDetail | null>(null);
const school = (): WorkspaceDetail => ({
  id: 'school',
  slug: 'school',
  name: '学校',
  description: '',
  status: 'active',
  preset: 'community',
  owner_id: 'owner',
  revision: 1,
  actor_id: 'student',
  permissions: [],
  is_member: false,
  platform_admin: false,
  configuration: {
    access: 'public',
    discoverable: true,
    join_policy: 'open',
    features: { community: true, classroom: false, assignment: false, analytics: false },
    homepage: 'community',
  },
});
beforeEach(() => {
  vi.clearAllMocks();
  domain.value = null;
  route.path = '/d/school';
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('watch', watch);
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('useRoute', () => route);
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal('navigateTo', navigate);
  vi.stubGlobal('useWorkspace', () => ({ domain, refresh: vi.fn() }));
  vi.stubGlobal('useWorkspaceApi', () => ({}));
  vi.stubGlobal('useAuth', () => ({ isLoggedIn: ref(true), user: ref({ id: 'student' }) }));
});
const mountHome = () =>
  mount(defineComponent({ components: { WorkspaceHome }, template: '<Suspense><WorkspaceHome /></Suspense>' }), {
    global: {
      stubs: {
        UCard: { template: '<div><slot /></div>' },
        UButton: { template: '<button><slot /></button>' },
        UTextarea: true,
        DomainHomeContent: true,
        Carousel: { props: ['domainSlug', 'title'], template: '<section data-testid="carousel">{{ title }}</section>' },
        HomepageCheckIn: true,
        AnnouncementSection: true,
        RandomProblems: true,
        LatestSubmissions: true,
        FollowingFeed: true,
      },
    },
  });
describe('明确的域首页不跳走', () => {
  it('已有成员进入域根页保持域首页，不自动跳到社区', async () => {
    domain.value = { ...school(), is_member: true };
    const view = mountHome();
    await flushPromises();
    expect(navigate).not.toHaveBeenCalled();
    expect(view.find('[data-testid="carousel"]').text()).toBe('学校');
    expect(view.find('random-problems-stub').attributes('domain-slug')).toBe('school');
    view.unmount();
  });
  it('迟到的当前域上下文或加入后可引导，其他资源页导航不会被旧概览抢走', async () => {
    const view = mountHome();
    await flushPromises();
    domain.value = school();
    await flushPromises();
    expect(navigate).not.toHaveBeenCalled();
    expect(view.text()).toContain('加入此域');
    domain.value = { ...school(), is_member: true };
    await flushPromises();
    expect(navigate).not.toHaveBeenCalled();
    navigate.mockClear();
    route.path = '/d/other/problems';
    domain.value = { ...school(), slug: 'other', is_member: true };
    await flushPromises();
    expect(navigate).not.toHaveBeenCalled();
    view.unmount();
  });
});
