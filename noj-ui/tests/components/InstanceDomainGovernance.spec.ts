import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref, Suspense, watch } from 'vue';
import Governance from '~/components/workspace/InstanceDomainGovernance.vue';
import { useInstanceAdmin } from '~/composables/useInstanceAdmin';
const api = { domains: vi.fn(), requests: vi.fn(), review: vi.fn() }, status = vi.fn(), confirm = vi.fn();
const user = ref({ id: 'admin' });
const pagination = { page: 1, per_page: 20, total: 50, total_pages: 3 };
beforeEach(() => {
  vi.clearAllMocks();
  user.value = { id: 'admin' };
  for (const [name, value] of Object.entries({ ref, watch, computed })) vi.stubGlobal(name, value);
  vi.stubGlobal('useInstanceAdmin', () => api);
  vi.stubGlobal('useWorkspaceApi', () => ({ status }));
  vi.stubGlobal('useAuth', () => ({ user }));
  vi.stubGlobal('useDialog', () => ({ dialog: { confirm } }));
  vi.stubGlobal('useAsyncData', async (key: () => string, handler: () => Promise<unknown>) => {
    const data = ref<unknown>(null), error = ref<unknown>(null);
    const refresh = async () => {
      try {
        data.value = await handler();
        error.value = null;
      } catch (e) {
        error.value = e;
      }
    };
    await refresh();
    watch(key, refresh);
    return { data, error, refresh, status: ref('success') };
  });
  api.domains.mockResolvedValue({
    data: [{
      id: 'private',
      slug: 'school',
      name: '私有学校',
      owner_username: 'teacher',
      status: 'suspended',
      preset: 'education',
      revision: 7,
    }],
    pagination,
  });
  api.requests.mockResolvedValue({
    data: [{
      id: 'request',
      slug: 'new-school',
      name: '新学校',
      applicant_username: 'applicant',
      applicant_deleted: false,
      status: 'pending',
      preset: 'education',
      reason: '创建教学空间',
      created_at: '2026-10-13',
    }],
    pagination,
  });
  confirm.mockResolvedValue(true);
  status.mockResolvedValue({});
  api.review.mockResolvedValue({});
});
async function view() {
  const wrapper = defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(Governance) }) });
  const result = mount(wrapper, {
    global: {
      stubs: {
        UCard: { template: '<section><slot /></section>' },
        AsyncContent: { template: '<div><slot /></div>' },
        UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
        UButton: { props: ['to'], template: '<button :data-to="to"><slot /></button>' },
        UInput: true,
        USelect: true,
        UPagination: { emits: ['update:page'], template: '<button @click="$emit(\'update:page\', 2)">第二页</button>' },
      },
    },
  });
  await flushPromises();
  return result;
}
describe('平台显式目标域治理', () => {
  it('暂停的私有域可恢复，原revision和slug确定目标，分页走服务端', async () => {
    const result = await view();
    expect(api.domains).toHaveBeenCalledWith({ page: 1, status: undefined, keyword: undefined });
    await result.findAll('button').find((button) => button.text() === '恢复使用')!.trigger('click');
    await flushPromises();
    expect(status).toHaveBeenCalledWith('school', 'active', 7);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('(school)'), expect.anything());
    expect(result.findAll('button').find((button) => button.text() === '管理设置与额度')!.attributes('data-to')).toBe(
      '/d/school/settings',
    );
    await result.findAll('button').find((button) => button.text() === '第二页')!.trigger('click');
    await flushPromises();
    expect(api.domains).toHaveBeenLastCalledWith({ page: 2, status: undefined, keyword: undefined });
  });
  it('审核失败保留申请，确认期间身份变化不会发送旧审核', async () => {
    const result = await view();
    api.review.mockRejectedValue({ statusCode: 409, data: { error: '申请已经处理' } });
    await result.findAll('button').find((button) => button.text() === '批准创建')!.trigger('click');
    await flushPromises();
    expect(result.text()).toContain('申请已经处理');
    expect(result.text()).toContain('创建教学空间');
    let resolve!: (answer: boolean) => void;
    confirm.mockReturnValue(
      new Promise<boolean>((done) => {
        resolve = done;
      }),
    );
    api.review.mockClear();
    await result.findAll('button').find((button) => button.text() === '拒绝申请')!.trigger('click');
    user.value = { id: 'another-admin' };
    resolve(true);
    await flushPromises();
    expect(api.review).not.toHaveBeenCalled();
  });
  it('接口保存注册表时间戳，治理查询不借公开域目录', async () => {
    const get = vi.fn(), put = vi.fn();
    vi.stubGlobal('useApi', () => ({ api: { get, put } }));
    const instance = useInstanceAdmin();
    await instance.saveSetting({
      key: 'domain_creation_policy',
      effective_value: 'admin',
      updated_at: '2026-10-13T10:00:00Z',
      source: 'db',
    }, 'approval');
    await instance.requests({ page: 2, status: 'pending' });
    expect(put).toHaveBeenCalledWith('/api/v1/admin/system/settings/domain_creation_policy', { value: 'approval' }, {
      silent: true,
      headers: { 'If-Match': '"2026-10-13T10:00:00Z"' },
    });
    expect(get).toHaveBeenCalledWith('/api/v1/admin/instance/domain-creation-requests', {
      query: { page: 2, status: 'pending', per_page: 20 },
      silent: true,
    });
  });
});
