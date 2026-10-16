import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, ref } from 'vue';
import Menu from '~/components/feature/training/DomainAddToTrainingMenu.vue';

const { success } = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock('~/composables/useToast', () => ({ useToast: () => ({ toast: { success } }) }));
const api = { list: vi.fn(), detail: vi.fn(), save: vi.fn() };
const problem = {
  problem_id: 'source',
  source_domain_id: 'main',
  source_domain_slug: 'main',
  number: 1001,
  qualified_ref: 'main:1001',
  display_ref: 'main:1001',
  is_shared: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('useDomainTrainings', () => api);
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal('useWorkspace', () => ({ can: () => true }));
  api.list.mockResolvedValue({
    items: [{ id: 'training', title: '训练题单', can_edit: true }, {
      id: 'readonly',
      title: '不可编辑题单',
      can_edit: false,
    }],
    total: 2,
    limit: 20,
  });
  api.detail.mockResolvedValue({
    data: {
      id: 'training',
      title: '训练题单',
      description: '说明',
      visibility: 'private',
      revision: 7,
      items: [{ problem_id: 'existing', display_ref: '2001' }],
    },
  });
  api.save.mockResolvedValue({ data: { id: 'training' } });
});

async function view() {
  const wrapper = mount(Menu, {
    props: { slug: 'school', problem },
    global: {
      stubs: {
        UButton: { template: '<button><slot /></button>' },
        UModal: { template: '<section><slot name="body" /></section>' },
        UInput: true,
        UAlert: true,
        PaginationNav: true,
        NuxtLink: { template: '<a><slot /></a>' },
      },
    },
  });
  await wrapper.findAll('button')[0]!.trigger('click');
  await flushPromises();
  return wrapper;
}

describe('当前域加入题单', () => {
  it('只列出可编辑题单，保留原顺序并携带 revision 保存来源题号', async () => {
    const wrapper = await view();
    expect(wrapper.text()).not.toContain('不可编辑题单');
    await wrapper.findAll('button').find((button) => button.text() === '加入')!.trigger('click');
    await flushPromises();
    expect(api.save).toHaveBeenCalledWith('school', {
      title: '训练题单',
      description: '说明',
      visibility: 'private',
      problems: ['2001', 'main:1001'],
    }, { id: 'training', revision: 7 });
    expect(success).toHaveBeenCalledWith('已加入题单');
    wrapper.unmount();
  });
  it('同一源题已经存在时不重复写入，也不改动题单版本', async () => {
    api.detail.mockResolvedValue({ data: { id: 'training', revision: 7, items: [{ problem_id: 'source' }] } });
    const wrapper = await view();
    await wrapper.findAll('button').find((button) => button.text() === '加入')!.trigger('click');
    await flushPromises();
    expect(api.save).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith('已加入题单');
    wrapper.unmount();
  });
});
