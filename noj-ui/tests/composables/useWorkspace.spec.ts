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
const error = ref<unknown>(null);
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
  error.value = null;
  route.path = '/d/school-one/members';
  actor.value = { id: 'user-one' };
  data.value = { data: detail() };
  api.get.mockReset();
  vi.stubGlobal('useRoute', () => route);
  vi.stubGlobal('useState', () => actor);
  vi.stubGlobal('useAsyncData', (_key: unknown, load: () => Promise<unknown>) => {
    asyncDataCalls++;
    handler = load;
    return { data, status, error, refresh: vi.fn() };
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
  it('切换 URL 或用户时立即丢弃旧域事实；同域同用户后台刷新中保留权限避免闪烁', () => {
    const view = mounted();
    expect(view.context().can('domain:members')).toBe(true);
    status.value = 'pending';
    expect(view.context().domain.value?.name).toBe('学校一');
    expect(view.context().can('domain:members')).toBe(true);
    route.path = '/d/school-two';
    expect(view.context().domain.value).toBeNull();
    expect(view.context().can('domain:members')).toBe(false);
    route.path = '/d/school-one';
    actor.value = { id: 'user-two' };
    expect(view.context().domain.value).toBeNull();
    expect(view.context().can('domain:members')).toBe(false);
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
  it('真 401/403/404 错误清除旧域上下文和权限', () => {
    const view = mounted();
    expect(view.context().domain.value?.name).toBe('学校一');
    expect(view.context().can('domain:members')).toBe(true);
    expect(view.context().writable.value).toBe(true);

    error.value = { statusCode: 401, data: { error: '未登录' } };
    expect(view.context().domain.value).toBeNull();
    expect(view.context().can('domain:members')).toBe(false);
    expect(view.context().writable.value).toBe(false);

    error.value = { statusCode: 403, data: { error: '无权访问' } };
    expect(view.context().domain.value).toBeNull();
    expect(view.context().can('domain:members')).toBe(false);
    expect(view.context().writable.value).toBe(false);

    error.value = { statusCode: 404, data: { error: '空间不存在' } };
    expect(view.context().domain.value).toBeNull();
    expect(view.context().can('domain:members')).toBe(false);
    expect(view.context().writable.value).toBe(false);

    view.wrapper.unmount();
  });
  it('503 或网络错误导致 data 清空时保留原域数据以保存草稿，但禁用写入 (writable 为 false，domain.status 保持原样不出现假归档)', () => {
    const view = mounted();
    expect(view.context().domain.value?.name).toBe('学校一');
    expect(view.context().domain.value?.status).toBe('active');
    expect(view.context().writable.value).toBe(true);

    // 真实模拟 Nuxt 刷新失败后 data 清空并设置 503
    data.value = { data: null };
    status.value = 'error';
    error.value = { statusCode: 503, data: { error: 'Service Unavailable' } };
    expect(view.context().domain.value?.name).toBe('学校一');
    expect(view.context().domain.value?.status).toBe('active');
    expect(view.context().writable.value).toBe(false);

    // 网络错误
    error.value = new TypeError('Failed to fetch');
    expect(view.context().domain.value?.name).toBe('学校一');
    expect(view.context().domain.value?.status).toBe('active');
    expect(view.context().writable.value).toBe(false);

    // 401/403/404 清空
    error.value = { statusCode: 403, data: { error: '无权访问' } };
    expect(view.context().domain.value).toBeNull();
    expect(view.context().writable.value).toBe(false);

    view.wrapper.unmount();
  });
});
