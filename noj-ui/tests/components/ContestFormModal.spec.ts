import { beforeAll, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';
import ContestFormModal from '~/components/admin/ContestFormModal.vue';

const mockUser = ref({ is_admin: true, permissions: ['admin:full_access'] });

beforeAll(() => {
  vi.stubGlobal('useAuth', () => ({ user: mockUser }));
});

const USlideoverStub = defineComponent({
  name: 'USlideover',
  props: {
    open: { type: Boolean, default: false },
    side: { type: String, default: 'right' },
    ui: { type: Object, default: () => ({}) },
  },
  emits: ['update:open'],
  setup(props, { slots }) {
    return () =>
      props.open
        ? h('div', { class: 'slideover-stub', 'data-side': props.side }, [
          slots.title ? h('div', { class: 'slideover-title' }, slots.title()) : null,
          slots.body ? h('div', { class: 'slideover-body' }, slots.body()) : null,
          slots.footer ? h('div', { class: 'slideover-footer' }, slots.footer()) : null,
        ])
        : null;
  },
});

const stubs = {
  USlideover: USlideoverStub,
  UIcon: true,
  UButton: true,
};

describe('ContestFormModal 抽屉形态与交互', () => {
  it('open=false 时不渲染抽屉内容', () => {
    const wrapper = mount(ContestFormModal, {
      props: { open: false, problems: [] },
      global: { stubs },
    });
    expect(wrapper.find('.slideover-stub').exists()).toBe(false);
  });

  it('open=true 且无 contest 时渲染「创建竞赛」抽屉与默认表单', () => {
    const wrapper = mount(ContestFormModal, {
      props: { open: true, problems: [] },
      global: { stubs },
    });
    expect(wrapper.find('.slideover-stub').exists()).toBe(true);
    expect(wrapper.text()).toContain('创建竞赛');
    expect(wrapper.text()).toContain('竞赛标题');
  });

  it('open=true 且有 contest 时渲染「编辑竞赛」抽屉并预填标题', () => {
    const wrapper = mount(ContestFormModal, {
      props: {
        open: true,
        contest: {
          id: 'c1',
          public_id: 'C100',
          title: '秋季排位赛',
          description: '秋季挑战',
          announcement: '',
          start_time: '2026-10-01T08:00:00Z',
          end_time: '2026-10-01T12:00:00Z',
          type: 'kaggle',
          kind: 'invite',
          config: {},
          is_public: false,
          has_password: true,
          affect_global_ranking: false,
          ranking_visibility: 'public',
          freeze_duration_seconds: 0,
          freeze_start_time: null,
          status: 'pending',
          participant_count: 0,
          problem_count: 0,
          problems: [],
        },
        problems: [],
      },
      global: { stubs },
    });
    expect(wrapper.find('.slideover-stub').exists()).toBe(true);
    expect(wrapper.text()).toContain('编辑竞赛');
    const titleInput = wrapper.find('input[placeholder="例如：NOJ 夏季挑战赛"]');
    expect(titleInput.exists()).toBe(true);
    expect((titleInput.element as HTMLInputElement).value).toBe('秋季排位赛');
  });

  it('支持拖动/按钮重排题目顺序，且题目标签 A, B 自动重新编号', async () => {
    const wrapper = mount(ContestFormModal, {
      props: {
        open: true,
        contest: {
          id: 'c1',
          public_id: 'C100',
          title: '测序竞赛',
          description: '',
          announcement: '',
          start_time: '2026-10-01T08:00:00Z',
          end_time: '2026-10-01T12:00:00Z',
          type: 'kaggle',
          kind: 'invite',
          config: {},
          is_public: false,
          has_password: false,
          affect_global_ranking: false,
          ranking_visibility: 'public',
          freeze_duration_seconds: 0,
          freeze_start_time: null,
          status: 'pending',
          participant_count: 0,
          problem_count: 2,
          problems: [
            { problem_id: 'p1', display_id: 'P1001', title: '第一题', label: 'A', score: 10000, sort_order: 0 },
            { problem_id: 'p2', display_id: 'P1002', title: '第二题', label: 'B', score: 10000, sort_order: 1 },
          ],
        },
        problems: [
          { id: 'p1', display_id: 'P1001', title: '第一题', visibility: 'public' },
          { id: 'p2', display_id: 'P1002', title: '第二题', visibility: 'public' },
        ],
      },
      global: { stubs },
    });

    const items = wrapper.findAll('[draggable="true"]');
    expect(items.length).toBe(2);

    // 初始状态下第一项为 P1001 第一题 (A)，第二项为 P1002 第二题 (B)
    expect(items[0].text()).toContain('A');
    expect(items[0].text()).toContain('第一题');
    expect(items[1].text()).toContain('B');
    expect(items[1].text()).toContain('第二题');

    // 点击第一题的「下移」按钮
    const downBtn = items[0].find('button[title="下移"]');
    expect(downBtn.exists()).toBe(true);
    await downBtn.trigger('click');

    // 调序后，第二题变为 A，第一题变为 B
    const updatedItems = wrapper.findAll('[draggable="true"]');
    expect(updatedItems[0].text()).toContain('A');
    expect(updatedItems[0].text()).toContain('第二题');
    expect(updatedItems[1].text()).toContain('B');
    expect(updatedItems[1].text()).toContain('第一题');

    // 测试拖拽事件 drop 换位回到原来位置
    await updatedItems[1].trigger('dragstart');
    await updatedItems[0].trigger('drop');

    const revertedItems = wrapper.findAll('[draggable="true"]');
    expect(revertedItems[0].text()).toContain('A');
    expect(revertedItems[0].text()).toContain('第一题');
    expect(revertedItems[1].text()).toContain('B');
    expect(revertedItems[1].text()).toContain('第二题');
  });
});
