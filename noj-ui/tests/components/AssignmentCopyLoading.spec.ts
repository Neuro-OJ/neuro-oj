import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, ref, watch } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import AssignmentCopy from '~/components/education/AssignmentCopy.vue';
import type { AssignmentDetail } from '~/utils/education';

const members = vi.fn();
let current = true;
beforeEach(() => {
  current = true;
  members.mockReset().mockResolvedValue({ data: [] });
  for (const [name, value] of Object.entries({ ref, computed, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('useState', () => ref({ id: 'coach' }));
  vi.stubGlobal('useEducationApi', () => ({ members }));
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => current }));
});
function view() {
  return mount(AssignmentCopy, {
    props: {
      slug: 'school',
      task: { id: 'a', classroom_id: 'c', title: '作业', revision: 1, items: [] } as unknown as AssignmentDetail,
      writable: true,
    },
    global: {
      stubs: {
        UButton: { template: '<button><slot /></button>' },
        UModal: { props: ['open'], template: '<section :data-open="open"><slot name="body" /></section>' },
        UInput: true,
        USelect: true,
        UAlert: true,
        UCheckbox: true,
        AdminFormField: { template: '<label><slot /></label>' },
      },
    },
  });
}
describe('复制作业名单按需加载', () => {
  it('详情首屏不读取隐藏弹窗的成员名单', () => {
    const wrapper = view();
    expect(members).not.toHaveBeenCalled();
    wrapper.unmount();
  });
  it('打开复制弹窗才读取一次当前空间名单', async () => {
    const wrapper = view();
    await wrapper.find('button').trigger('click');
    await flushPromises();
    expect(members).toHaveBeenCalledOnce();
    expect(members).toHaveBeenCalledWith('school', 'c');
    expect(wrapper.find('section').attributes('data-open')).toBe('true');
    wrapper.unmount();
  });
  it('读取期间切换空间不打开旧弹窗', async () => {
    let finish: (value: unknown) => void;
    members.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const wrapper = view();
    await wrapper.find('button').trigger('click');
    current = false;
    finish!({ data: [] });
    await flushPromises();
    expect(wrapper.find('section').attributes('data-open')).toBe('false');
    wrapper.unmount();
  });
});
