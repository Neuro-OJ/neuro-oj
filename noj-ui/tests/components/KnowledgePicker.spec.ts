import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { computed, defineComponent, h, ref } from 'vue';

const graph = {
  pack: { id: 'official', version: '1.0.0' },
  areas: [
    { id: 'ds', name: '数据结构', sort: 1 },
    { id: 'alg', name: '算法', sort: 2 },
  ],
  nodes: [
    { id: 'ds.array', area: 'ds', name: '数组', summary: null, requires: [] },
    { id: 'ds.stack', area: 'ds', name: '栈', summary: null, requires: [] },
    { id: 'alg.dp', area: 'alg', name: '动态规划', summary: null, requires: [] },
    { id: 'alg.greedy', area: 'alg', name: '贪心', summary: null, requires: [] },
  ],
};

beforeEach(() => {
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('computed', computed);
});

async function view(modelValue: { primary: string; secondary: string[] }, graphValue: unknown = graph) {
  const { default: KnowledgePicker } = await import('~/components/knowledge/KnowledgePicker.vue');
  const Wrapper = defineComponent({
    setup() {
      const value = ref(modelValue);
      return () =>
        h(KnowledgePicker, {
          modelValue: value.value,
          graph: graphValue,
          'onUpdate:modelValue': (next: typeof value.value) => {
            value.value = next;
          },
        });
    },
  });
  const wrapper = mount(Wrapper, {
    global: { stubs: { UBadge: { template: '<span><slot /></span>' }, UInput: { template: '<input />' } } },
  });
  return wrapper;
}

function radio(wrapper: Awaited<ReturnType<typeof view>>, id: string) {
  return wrapper.get(`input[name="knowledge-primary"][value="${id}"]`);
}

describe('KnowledgePicker', () => {
  it('按领域分组渲染节点，选中主知识点时回传选择值', async () => {
    const wrapper = await view({ primary: '', secondary: [] });
    expect(wrapper.text()).toContain('数据结构');
    expect(wrapper.text()).toContain('算法');
    expect(wrapper.text()).toContain('动态规划');
    await radio(wrapper, 'alg.dp').setValue(true);
    const emitted = wrapper.findComponent({ name: 'KnowledgePicker' }).emitted('update:modelValue') ?? [];
    expect(emitted.at(-1)?.[0]).toEqual({ primary: 'alg.dp', secondary: [] });
  });

  it('未选主知识点时不能添加次要知识点提醒', async () => {
    const wrapper = await view({ primary: '', secondary: [] });
    expect(wrapper.text()).toContain('请先选择主知识点');
    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it('次要知识点最多 3 个，达到上限后不再渲染勾选列表', async () => {
    const wrapper = await view({ primary: 'ds.array', secondary: ['ds.stack', 'alg.dp', 'alg.greedy'] });
    expect(wrapper.text()).toContain('已选满 3 个次要知识点');
    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it('勾选次要知识点时排除主知识点，重复勾选即取消', async () => {
    const wrapper = await view({ primary: 'ds.array', secondary: ['ds.stack'] });
    const boxes = wrapper.findAll('input[type="checkbox"]');
    // 主知识点不出现在次要列表
    expect(boxes.some((box) => (box.element as HTMLInputElement).value === 'ds.array')).toBe(false);
    await wrapper.get('input[type="checkbox"][value="alg.dp"]').setValue(true);
    await wrapper.get('input[type="checkbox"][value="alg.greedy"]').setValue(false);
    const emitted = wrapper.findComponent({ name: 'KnowledgePicker' }).emitted('update:modelValue') ?? [];
    const last = emitted.at(-1)?.[0] as { primary: string; secondary: string[] };
    expect(last.primary).toBe('ds.array');
    expect(last.secondary).not.toContain('alg.greedy');
    expect(last.secondary).not.toContain('ds.array');
  });

  it('图谱为空时显示导入提示', async () => {
    const wrapper = await view({ primary: '', secondary: [] }, null);
    expect(wrapper.text()).toContain('暂无可用知识点');
  });
});
