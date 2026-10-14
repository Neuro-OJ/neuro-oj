import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, reactive, ref, shallowRef, Suspense, watch } from 'vue';
import LlmPage from '~/pages/d/[slug]/llm/index.vue';
import { useDomainLlm } from '~/composables/useDomainLlm';
const api = {
  settings: vi.fn(),
  providers: vi.fn(),
  quotas: vi.fn(),
  usage: vi.fn(),
  saveSettings: vi.fn(),
  provider: vi.fn(),
  updateProvider: vi.fn(),
  saveQuota: vi.fn(),
  testProvider: vi.fn(),
};
const scope = ref('school'), user = ref({ id: 'owner' });
const provider = (revision = 3) => ({
  id: 'p1',
  domain_id: 'school-id',
  name: '本域模型服务',
  base_url: 'https://example.com/v1',
  api_key_masked: '***',
  enabled: true,
  cost_per_1k_tokens: 1,
  revision,
});
const quotaRow = (revision = 5) => ({
  id: 'q1',
  scope_type: 'domain',
  scope_id: '',
  window_type: 'day',
  max_calls: 10,
  max_tokens: null,
  max_cost: null,
  revision,
});
const caps = {
  day: { max_calls: 100, max_tokens: 2000, max_cost: 50 },
  month: { max_calls: null, max_tokens: null, max_cost: null },
};
beforeEach(() => {
  vi.clearAllMocks();
  scope.value = 'school';
  user.value = { id: 'owner' };
  for (const [name, value] of Object.entries({ computed, ref, reactive, shallowRef, watch })) {
    vi.stubGlobal(name, value);
  }
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal('useAuth', () => ({ user }));
  vi.stubGlobal('useWorkspace', () => ({ slug: scope, domain: ref({ status: 'active' }), can: () => true }));
  vi.stubGlobal('useWorkspaceActionScope', () => () => {
    const slug = scope.value, actor = user.value.id;
    return { slug, isCurrent: () => scope.value === slug && user.value.id === actor };
  });
  vi.stubGlobal('useDomainLlm', () => api);
  vi.stubGlobal(
    'useWorkspaceApi',
    () => ({
      members: vi.fn().mockResolvedValue({
        data: [{ user_id: 'u1', username: '学生甲', status: 'active' }],
        page: 1,
        per_page: 100,
      }),
    }),
  );
  vi.stubGlobal(
    'useDomainProblems',
    () => ({
      list: vi.fn().mockResolvedValue({
        items: [{ title: '公开 LLM 题', reference: { problem_id: 'source-problem', display_ref: 'main:1001' } }],
        total: 1,
      }),
    }),
  );
  vi.stubGlobal('useAsyncData', async (key: (() => string) | { value: string }, handler: () => Promise<unknown>) => {
    const data = shallowRef<unknown>(null), error = ref<unknown>(null);
    const refresh = async () => {
      try {
        data.value = await handler();
        error.value = null;
      } catch (e) {
        error.value = e;
      }
    };
    await refresh();
    watch(typeof key === 'function' ? key : () => key.value, refresh);
    return { data, error, refresh, status: ref('success') };
  });
  api.settings.mockResolvedValue({ data: { provider_id: 'p1', model: 'original', revision: 2 } });
  api.providers.mockResolvedValue({ data: [provider()] });
  api.quotas.mockResolvedValue({ data: [quotaRow()], caps });
  api.usage.mockResolvedValue({ data: [] });
  api.updateProvider.mockResolvedValue({});
  api.saveQuota.mockResolvedValue({ data: { id: 'q1', revision: 6 } });
});
const input = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
};
async function view() {
  const wrapper = defineComponent({ setup: () => () => h(Suspense, null, { default: () => h(LlmPage) }) });
  const result = mount(wrapper, {
    global: {
      stubs: {
        UCard: { template: '<section><slot /></section>' },
        DomainLlmAliases: true,
        UAlert: { props: ['title', 'description'], template: '<p>{{ title }} {{ description }}</p>' },
        UButton: { template: '<button><slot /></button>' },
        UInput: input,
        UCheckbox: true,
        UBadge: { template: '<span><slot /></span>' },
        AdminFormField: { props: ['label'], template: '<label>{{ label }}<slot /></label>' },
        USelect: {
          props: ['modelValue', 'items'],
          emits: ['update:modelValue'],
          template:
            '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="item in items" :value="item.value">{{ item.label }}</option></select>',
        },
        UModal: { props: ['open'], template: '<div v-if="open"><slot name="body" /></div>' },
      },
    },
  });
  await flushPromises();
  return result;
}
describe('域 LLM 并发编辑与自然配额对象', () => {
  it('种子参考值与实际额度分开，使用参考值须选择目标并新增，不改写空作用域', async () => {
    api.quotas.mockResolvedValue({
      data: [quotaRow(), { ...quotaRow(), id: 'seed-user', scope_type: 'user', scope_id: '' }],
      caps,
    });
    const result = await view();
    expect(result.get('details').text()).toContain('额度参考值（未生效）');
    expect(result.get('details').text()).toContain('不限制实际调用');
    expect(result.findAll('button').filter((button) => button.text() === '编辑配额')).toHaveLength(1);
    await result.get('details button').trigger('click');
    expect((result.get('select[aria-label="配额用户"]').element as HTMLSelectElement).value).toBe('none');
    expect(result.text()).not.toContain('此前选择的用户');
    await result.get('select[aria-label="配额用户"]').setValue('u1');
    await result.findAll('form').find((form) => form.text().includes('新增配额'))!.trigger('submit');
    await flushPromises();
    expect(api.saveQuota).toHaveBeenCalledWith(
      'school',
      expect.objectContaining({ scope_type: 'user', scope_id: 'u1' }),
      0,
    );
    result.unmount();
  });
  it('Provider编辑保留RPM和TPM，连接测试明确属于当前域Provider', async () => {
    api.providers.mockResolvedValue({ data: [{ ...provider(), rpm_limit: 12, tpm_limit: 3000 }] });
    api.testProvider.mockResolvedValue({ data: { status: 'ok', model: 'school-model', latency_ms: 18 } });
    const result = await view();
    await result.findAll('button').find((button) => button.text() === '编辑')!.trigger('click');
    expect((result.get('input[aria-label="Provider RPM 上限"]').element as HTMLInputElement).value).toBe('12');
    await result.findAll('form').find((form) => form.text().includes('API Key'))!.trigger('submit');
    await flushPromises();
    expect(api.updateProvider).toHaveBeenCalledWith(
      'school',
      'p1',
      expect.objectContaining({ rpm_limit: 12, tpm_limit: 3000 }),
      3,
    );
    await result.findAll('button').find((button) => button.text() === '测试连接')!.trigger('click');
    await result.get('input[aria-label="Provider 测试模型"]').setValue('school-model');
    await result.findAll('form').find((form) => form.text().includes('运行连接测试'))!.trigger('submit');
    await flushPromises();
    expect(api.testProvider).toHaveBeenCalledWith('school', 'p1', 'school-model');
    expect(result.text()).toContain('连接成功，耗时 18 ms');
  });
  it('成功保存使用自己的写响应版本，随后列表有别人的新版本也不冒充自己的编辑依据', async () => {
    const result = await view();
    await result.findAll('button').find((button) => button.text() === '编辑配额')!.trigger('click');
    await result.get('input[aria-label="调用次数上限"]').setValue('6');
    api.quotas.mockResolvedValue({ data: [quotaRow(9)], caps });
    await result.findAll('form').find((form) => form.text().includes('更新配额'))!.trigger('submit');
    await flushPromises();
    await result.get('input[aria-label="调用次数上限"]').setValue('5');
    await result.findAll('form').find((form) => form.text().includes('更新配额'))!.trigger('submit');
    await flushPromises();
    expect(api.saveQuota).toHaveBeenLastCalledWith('school', expect.objectContaining({ id: 'q1', max_calls: 5 }), 6);
  });
  it('Provider冲突保留表单和打开时版本，重读列表不偷换编辑依据', async () => {
    const result = await view();
    await result.findAll('button').find((button) => button.text() === '编辑')!.trigger('click');
    const name = result.findAll('label').find((label) => label.text() === '名称')!.get('input');
    await name.setValue('我的未保存编辑');
    api.updateProvider.mockRejectedValue({ statusCode: 409, data: { error: 'Provider 已变化' } });
    await result.findAll('form').find((form) => form.text().includes('API Key'))!.trigger('submit');
    await flushPromises();
    expect(api.updateProvider).toHaveBeenLastCalledWith(
      'school',
      'p1',
      expect.objectContaining({ name: '我的未保存编辑' }),
      3,
    );
    expect(result.text()).toContain('Provider 已变化');
    expect((name.element as HTMLInputElement).value).toBe('我的未保存编辑');
    api.providers.mockResolvedValue({ data: [provider(9)] });
    await result.findAll('button').find((button) => button.text() === '重新读取 Provider 与额度列表')!.trigger('click');
    await flushPromises();
    await result.findAll('form').find((form) => form.text().includes('API Key'))!.trigger('submit');
    await flushPromises();
    expect(api.updateProvider).toHaveBeenLastCalledWith('school', 'p1', expect.anything(), 3);
  });
  it('quota冲突保留原revision，保存Provider不覆盖未保存默认模型', async () => {
    const result = await view();
    await result.get('input[aria-label="默认模型"]').setValue('尚未保存模型');
    await result.findAll('button').find((button) => button.text() === '停用')!.trigger('click');
    await flushPromises();
    expect((result.get('input[aria-label="默认模型"]').element as HTMLInputElement).value).toBe('尚未保存模型');
    await result.findAll('button').find((button) => button.text() === '编辑配额')!.trigger('click');
    await result.get('input[aria-label="调用次数上限"]').setValue('6');
    api.saveQuota.mockRejectedValue({ statusCode: 409, data: { error: '额度已经变化' } });
    await result.findAll('form').find((form) => form.text().includes('更新配额'))!.trigger('submit');
    await flushPromises();
    expect(api.saveQuota).toHaveBeenCalledWith('school', expect.objectContaining({ id: 'q1', max_calls: 6 }), 5);
    expect(result.text()).toContain('额度已经变化');
    expect((result.get('input[aria-label="调用次数上限"]').element as HTMLInputElement).value).toBe('6');
  });
  it('用户×源题显示用户名和来源题号，创建发送stable IDs和版本0', async () => {
    const result = await view();
    await result.get('select[aria-label="配额作用域"]').setValue('user_problem');
    expect(result.text()).toContain('学生甲');
    expect(result.text()).toContain('main:1001');
    await result.get('select[aria-label="配额用户"]').setValue('u1');
    await result.get('select[aria-label="配额来源题目"]').setValue('source-problem');
    await result.findAll('form').find((form) => form.text().includes('新增配额'))!.trigger('submit');
    await flushPromises();
    expect(api.saveQuota).toHaveBeenCalledWith(
      'school',
      expect.objectContaining({ scope_type: 'user_problem', scope_id: 'u1:source-problem', max_calls: null }),
      0,
    );
    expect(result.text()).toContain('每日实例允许上限：100 次 / 2000 Token / 50 费用整数');
    expect(result.find('input[aria-label="配额对象"]').exists()).toBe(false);
  });
  it('切域或账号关闭旧编辑，旧请求完成不覆盖新域列表', async () => {
    const result = await view();
    await result.findAll('button').find((button) => button.text() === '编辑')!.trigger('click');
    let resolve!: () => void;
    api.updateProvider.mockReturnValue(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    await result.findAll('form').find((form) => form.text().includes('API Key'))!.trigger('submit');
    scope.value = 'second-school';
    user.value = { id: 'second-owner' };
    await flushPromises();
    const requests = api.providers.mock.calls.length;
    resolve();
    await flushPromises();
    expect(api.providers.mock.calls.length).toBe(requests);
    expect(result.findAll('form').some((form) => form.text().includes('API Key'))).toBe(false);
  });
  it('创建与更新前置条件属于资源row而非Domain revision', async () => {
    const post = vi.fn(), put = vi.fn();
    vi.stubGlobal('useApi', () => ({ api: { post, put } }));
    const manager = useDomainLlm();
    const input = {
      name: 'p',
      base_url: 'https://example.com',
      api_key: 'secret',
      cost_per_1k_tokens: 0,
      enabled: true,
    };
    await manager.provider('school', input);
    await manager.updateProvider('school', 'p1', { enabled: false }, 3);
    await manager.saveQuota('school', {
      scope_type: 'domain',
      scope_id: '',
      window_type: 'day',
      max_calls: null,
      max_tokens: null,
      max_cost: null,
    }, 0);
    expect(post).toHaveBeenCalledWith('/api/v1/domains/school/llm/providers', input, {
      headers: { 'If-Match': '0' },
      silent: true,
    });
    expect(put).toHaveBeenCalledWith('/api/v1/domains/school/llm/providers/p1', { enabled: false }, {
      headers: { 'If-Match': '3' },
      silent: true,
    });
    expect(post).toHaveBeenLastCalledWith('/api/v1/domains/school/llm/quotas', expect.anything(), {
      headers: { 'If-Match': '0' },
      silent: true,
    });
  });
});
