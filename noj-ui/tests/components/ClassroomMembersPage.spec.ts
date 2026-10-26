import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense, watch } from 'vue';

const mockDialog = vi.hoisted(() => ({
  confirm: vi.fn(),
}));

const mockEducation = vi.hoisted(() => ({
  classroom: vi.fn(),
  members: vi.fn(),
  setMember: vi.fn(),
  removeMember: vi.fn(),
}));

const mockToast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const mockApi = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), delete: vi.fn() }));

vi.mock('~/composables/useToast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('~/composables/useApi', () => ({ useApi: () => ({ api: mockApi }) }));
vi.mock('~/composables/useDialog', () => ({ useDialog: () => ({ dialog: mockDialog }) }));

import MembersPage from '~/pages/d/[slug]/classrooms/[classroomId]/members.vue';

const stubs = {
  AdminPageHeader: {
    props: ['title', 'description'],
    template: '<div><h1>{{ title }}</h1><p>{{ description }}</p></div>',
  },
  UCard: { template: '<div><slot /></div>' },
  UButton: {
    props: ['disabled', 'to'],
    template: '<button :disabled="disabled" :data-to="to"><slot /></button>',
  },
  USelect: { template: '<select />' },
  UCheckbox: { template: '<input type="checkbox" />' },
  UModal: { template: '<div><slot name="body" /></div>' },
  UAlert: { template: '<div><slot /></div>' },
  NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
  AsyncContent: {
    props: ['status'],
    template: '<div><slot /></div>',
  },
  ClassroomImport: {
    props: ['slug', 'classroomId', 'writable'],
    template: '<div data-testid="classroom-import" />',
  },
  ClassroomJoinRequests: {
    props: ['slug', 'classroomId', 'writable'],
    template: '<div data-testid="classroom-join-requests" />',
  },
  InvitationManager: {
    props: ['domainSlug', 'classroomId', 'writable'],
    template:
      '<div data-testid="invitation-manager" :data-slug="domainSlug" :data-classroom="classroomId" :data-writable="String(writable)" />',
  },
};

const mockDomain = ref<Record<string, unknown>>({
  status: 'active',
  configuration: { features: { classroom: true } },
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal('useRoute', () => ({ params: { slug: 'edu-domain', classroomId: 'room-1' }, query: {} }));
  vi.stubGlobal('useState', () => ref({ id: 'teacher' }));
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'teacher' }) }));
  vi.stubGlobal('useDialog', () => ({ dialog: mockDialog }));
  vi.stubGlobal('useToast', () => ({ toast: mockToast }));
  vi.stubGlobal('useWorkspace', () => ({
    slug: ref('edu-domain'),
    domain: mockDomain,
  }));
  vi.stubGlobal('useEducationApi', () => mockEducation);
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({
    slug: 'edu-domain',
    isCurrent: () => true,
  }));
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

  mockEducation.classroom.mockResolvedValue({
    data: {
      id: 'room-1',
      name: '算法进阶班',
      status: 'active',
      revision: 1,
      permissions: ['students:manage'],
      manages_domain: true,
      membership: { role: 'coach' },
    },
  });

  mockEducation.members.mockResolvedValue({
    data: [
      {
        id: 'm-1',
        user_id: 'u-1',
        username: 'student_bob',
        role: 'student',
        effective_active: true,
      },
    ],
  });
});

describe('pages/d/[slug]/classrooms/[classroomId]/members.vue', () => {
  it('具有管理权限时挂载 InvitationManager 并传入正确的域、班级和可写属性', async () => {
    const Wrapper = defineComponent({
      setup: () => () => h(Suspense, null, { default: () => h(MembersPage) }),
    });
    const view = mount(Wrapper, { global: { stubs } });
    await flushPromises();

    expect(view.text()).toContain('班级成员');
    expect(view.text()).toContain('算法进阶班');
    expect(view.text()).toContain('student_bob');

    // 验证 InvitationManager 被挂载且接收了 domainSlug 与 classroomId
    const inviteMgr = view.find('[data-testid="invitation-manager"]');
    expect(inviteMgr.exists()).toBe(true);
    expect(inviteMgr.attributes('data-slug')).toBe('edu-domain');
    expect(inviteMgr.attributes('data-classroom')).toBe('room-1');
    expect(inviteMgr.attributes('data-writable')).toBe('true');

    // 同时保留了导入和申请组件
    expect(view.find('[data-testid="classroom-import"]').exists()).toBe(true);
    expect(view.find('[data-testid="classroom-join-requests"]').exists()).toBe(true);

    view.unmount();
  });
});
