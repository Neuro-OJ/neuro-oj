import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, reactive, ref, Suspense } from 'vue';
import DomainLlmAliases from '~/components/feature/DomainLlmAliases.vue';
const api = { aliases: vi.fn(), saveAlias: vi.fn(), deleteAlias: vi.fn() }, confirm = vi.fn();
const slug = ref('school');
const row = {
  domain_id: 'school-id',
  alias: 'fast',
  provider_id: 'provider',
  model: 'model-a',
  description: '快速',
  revision: 3,
  problem_count: 1,
};
beforeEach(() => {
  vi.clearAllMocks();
  slug.value = 'school';
  for (const [name, value] of Object.entries({ computed, reactive, ref })) vi.stubGlobal(name, value);
  vi.stubGlobal('useAuth', () => ({ user: ref({ id: 'owner' }) }));
  vi.stubGlobal('useDomainLlm', () => api);
  vi.stubGlobal('useDialog', () => ({ dialog: { confirm } }));
  vi.stubGlobal('useWorkspaceActionScope', () => () => {
    const target = slug.value;
    return { slug: target, isCurrent: () => target === slug.value };
  });
  vi.stubGlobal('useAsyncData', async (_key: unknown, load: () => Promise<unknown>) => {
    const data = ref(await load());
    return {
      data,
      error: ref(null),
      refresh: async () => {
        data.value = await load();
      },
    };
  });
  api.aliases.mockResolvedValue({ data: [row] });
  confirm.mockResolvedValue(true);
});
async function view() {
  const Wrapper = defineComponent({
    setup: () => () =>
      h(Suspense, null, {
        default: () =>
          h(DomainLlmAliases, {
            slug: 'school',
            providers: [{ id: 'provider', name: '学校Provider' }],
            writable: true,
          }),
      }),
  });
  const result = mount(Wrapper, {
    global: {
      stubs: {
        UCard: { template: '<section><slot /></section>' },
        AdminFormField: { template: '<label><slot /></label>' },
        UAlert: { props: ['title'], template: '<p>{{ title }}</p>' },
        UButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
        UInput: {
          props: ['modelValue'],
          emits: ['update:modelValue'],
          template: '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
        USelect: { template: '<select />' },
      },
    },
  });
  await flushPromises();
  return result;
}
describe('Domain模型别名能力治理', () => {
  it('CAS冲突保留草稿和打开时revision，目录重读不代替编辑基线', async () => {
    const result = await view();
    await result.findAll('button').find((button) => button.text() === '编辑别名')!.trigger('click');
    await result.get('input[aria-label="别名实际模型"]').setValue('new-school-model');
    api.saveAlias.mockRejectedValue({ data: { error: '别名已被修改' }, statusCode: 409 });
    await result.get('form').trigger('submit');
    await flushPromises();
    expect(api.saveAlias).toHaveBeenCalledWith('school', 'fast', {
      provider_id: 'provider',
      model: 'new-school-model',
      description: '快速',
    }, 3);
    expect(result.text()).toContain('别名已被修改');
    expect((result.get('input[aria-label="别名实际模型"]').element as HTMLInputElement).value).toBe('new-school-model');
    api.aliases.mockResolvedValue({ data: [{ ...row, revision: 9 }] });
    await result.findAll('button').find((button) => button.text() === '重新读取')!.trigger('click');
    await flushPromises();
    await result.get('form').trigger('submit');
    await flushPromises();
    expect(api.saveAlias).toHaveBeenLastCalledWith('school', 'fast', expect.anything(), 3);
  });
  it('有引用时明确确认强制删除，确认期间切域不写其他域', async () => {
    const result = await view();
    confirm.mockImplementationOnce(() => {
      slug.value = 'other';
      return true;
    });
    await result.findAll('button').find((button) => button.text() === '删除别名')!.trigger('click');
    await flushPromises();
    expect(api.deleteAlias).not.toHaveBeenCalled();
    slug.value = 'school';
    await result.findAll('button').find((button) => button.text() === '删除别名')!.trigger('click');
    await flushPromises();
    expect(api.deleteAlias).toHaveBeenCalledWith('school', 'fast', 3, true);
  });
});
