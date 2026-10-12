import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, reactive, ref } from 'vue';
import { mount } from '@vue/test-utils';
import type { WorkspaceDetail } from '~/utils/workspace';

const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('~/composables/useApi', () => ({ useApi: () => ({ api }) }));
import { provideWorkspaceContext, useWorkspace, useWorkspaceActionScope } from '~/composables/useWorkspace';

const actor = ref<{ id: string } | null>({ id: 'user-one' });
const route = reactive({ path: '/d/school-one/members' });
const data = ref<{ data: WorkspaceDetail | null }>({ data: null });
const status = ref('success');
let handler: () => Promise<unknown>;
let asyncDataCalls = 0;
const detail = (): WorkspaceDetail => ({
  id: 'd1',
  slug: 'school-one',
  name: '学校一',
  description: '',
  status: 'active',
  owner_id: 'other',
  preset: 'education',
  configuration: {
    access: 'members',
    discoverable: false,
    join_policy: 'invite',
    features: { community: false, classroom: true, assignment: true, analytics: true },
    homepage: 'teaching',
  },
  revision: 0,
  actor_id: 'user-one',
  permissions: ['domain:members'],
  is_member: true,
  platform_admin: false,
});

beforeEach(() => {
  asyncDataCalls = 0;
  status.value = 'success';
  route.path = '/d/school-one/members';
  actor.value = { id: 'user-one' };
  data.value = { data: detail() };
  api.get.mockReset();
  vi.stubGlobal('useRoute', () => route);
  vi.stubGlobal('useState', () => actor);
  vi.stubGlobal('useAsyncData', (_key: unknown, load: () => Promise<unknown>) => {
    asyncDataCalls++;
    handler = load;
    return { data, status, error: ref(null), refresh: vi.fn() };
  });
});

function mounted() {
  let provider: ReturnType<typeof provideWorkspaceContext>;
  let child: ReturnType<typeof useWorkspace>;
  let captureAction: ReturnType<typeof useWorkspaceActionScope>;
  const Child = defineComponent({
    setup() {
      child = useWorkspace();
      captureAction = useWorkspaceActionScope();
      return () => h('span');
    },
  });
  const Parent = defineComponent({
    setup() {
      provider = provideWorkspaceContext();
      return () => h(Child);
    },
  });
  const wrapper = mount(Parent);
  return { wrapper, context: () => provider!, child: () => child!, action: () => captureAction!() };
}
describe('URL 工作空间上下文', () => {
  it('布局和子页面复用同一解析，避免重复请求和刷新导致反复挂载', () => {
    const view = mounted();
    expect(view.child()).toBe(view.context());
    expect(asyncDataCalls).toBe(1);
    view.wrapper.unmount();
  });
  it('切换 URL 或用户时立即丢弃旧域事实；刷新中保留同域显示但不使用旧权限', () => {
    const view = mounted();
    expect(view.context().can('domain:members')).toBe(true);
    status.value = 'pending';
    expect(view.context().domain.value?.name).toBe('学校一');
    expect(view.context().can('domain:members')).toBe(false);
    route.path = '/d/school-two';
    expect(view.context().domain.value).toBeNull();
    route.path = '/d/school-one';
    actor.value = { id: 'user-two' };
    expect(view.context().domain.value).toBeNull();
    view.wrapper.unmount();
  });
  it('服务端实际身份与请求时身份不一致时不保存返回的数据', async () => {
    const view = mounted();
    api.get.mockResolvedValue({ data: { ...detail(), actor_id: 'user-two' } });
    await expect(handler()).rejects.toThrow('登录身份已变化');
    view.wrapper.unmount();
  });
  it('确认或请求期间切换域、账号或离开页面，旧操作不能继续写入或显示邀请令牌', () => {
    const view = mounted();
    const action = view.action();
    expect(action.slug).toBe('school-one');
    expect(action.isCurrent()).toBe(true);
    route.path = '/d/school-two/members';
    expect(action.isCurrent()).toBe(false);
    route.path = '/d/school-one/members';
    actor.value = { id: 'user-two' };
    expect(action.isCurrent()).toBe(false);
    actor.value = { id: 'user-one' };
    view.wrapper.unmount();
    expect(action.isCurrent()).toBe(false);
  });
});
