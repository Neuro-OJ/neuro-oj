import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, onMounted, ref, watch } from 'vue';
import KnowledgePicker from '~/components/knowledge/KnowledgePicker.vue';

const api: Record<string, ReturnType<typeof vi.fn>> = {
  loadProblem: vi.fn(),
  loadGraph: vi.fn(),
  saveProblem: vi.fn(),
};
const disabled = ref(false);
const graph = ref({
  pack: null,
  areas: [{ id: 'ds', name: '数据结构', sort: 1 }],
  nodes: [{ id: 'ds.array', area: 'ds', name: '数组', summary: null, requires: [] }],
});

function viewOf(pending: boolean, source: 'ai' | 'human' = 'ai') {
  return {
    problem_id: 'p1',
    state: 'classified',
    primary: {
      node_id: 'ds.array',
      name: '数组',
      role: 'primary',
      source,
      confidence: 60,
      review_status: 'pending',
      version_id: null,
      updated_at: '',
    },
    secondary: [],
    pending,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  disabled.value = false;
  for (const [name, value] of Object.entries({ computed, ref, watch, onMounted })) vi.stubGlobal(name, value);
  vi.stubGlobal('useKnowledge', () => ({ disabled, graph, ...api }));
  api.loadGraph.mockResolvedValue(graph.value);
  api.loadProblem.mockResolvedValue(null);
});

async function view(writable = true) {
  const { default: Panel } = await import('~/components/knowledge/KnowledgeEditorPanel.vue');
  const Wrapper = defineComponent({ setup: () => () => h(Panel, { problemId: 'p1', writable }) });
  const wrapper = mount(Wrapper, {
    global: {
      stubs: {
        UCard: { template: '<section><slot /></section>' },
        UAlert: { props: ['title'], template: '<p class="alert">{{ title }}</p>' },
        UBadge: { template: '<span class="badge"><slot /></span>' },
        UButton: { props: ['disabled'], template: '<button :disabled="disabled"><slot /></button>' },
        // 用真实选择器（内部会真实渲染条目），保证面板与选择器协同可用。
        KnowledgePicker,
        UIcon: true,
        UInput: { props: ['modelValue'], template: '<input />' },
      },
    },
  });
  await flushPromises();
  return wrapper;
}

function button(wrapper: Awaited<ReturnType<typeof view>>, text: string) {
  const found = wrapper.findAll('button').find((item) => item.text() === text);
  if (!found) throw new Error(`按钮不存在：${text}`);
  return found;
}

describe('KnowledgeEditorPanel', () => {
  it('无编辑权限时不渲染也不请求', async () => {
    const wrapper = await view(false);
    expect(wrapper.find('.picker').exists()).toBe(false);
    expect(api.loadProblem).not.toHaveBeenCalled();
  });

  it('功能关闭（KNOWLEDGE_DISABLED）时整块隐藏', async () => {
    disabled.value = true;
    const wrapper = await view(true);
    expect(wrapper.find('.picker').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('知识点');
  });

  it('显示未归类状态，选择后保存调用 PUT 并提示已保存', async () => {
    const wrapper = await view();
    expect(wrapper.text()).toContain('未归类');
    const picker = wrapper.findComponent({ name: 'KnowledgePicker' });
    expect(picker.props('modelValue')).toEqual({ primary: '', secondary: [] });
    api.saveProblem.mockResolvedValue(viewOf(false, 'human'));
    // 模拟用户在选择器中选主知识点。
    (picker.vm as unknown as { $emit: (event: string, value: unknown) => void }).$emit('update:modelValue', {
      primary: 'ds.array',
      secondary: [],
    });
    await flushPromises();
    await button(wrapper, '保存知识点').trigger('click');
    await flushPromises();
    expect(api.saveProblem).toHaveBeenCalledWith('p1', { primary: 'ds.array', secondary: [] });
    expect(wrapper.text()).toContain('已确认 · 来源人工');
    expect(wrapper.text()).toContain('知识点已保存');
  });

  it('AI 待确认与来源 AI 状态展示', async () => {
    api.loadProblem.mockResolvedValue(viewOf(true, 'ai'));
    const wrapper = await view();
    expect(wrapper.text()).toContain('AI 待确认');
    expect(wrapper.findComponent({ name: 'KnowledgePicker' }).props('modelValue')).toEqual({
      primary: 'ds.array',
      secondary: [],
    });
  });

  it('保存失败展示后端错误且保留选择', async () => {
    const wrapper = await view();
    const picker = wrapper.findComponent({ name: 'KnowledgePicker' });
    (picker.vm as unknown as { $emit: (event: string, value: unknown) => void }).$emit('update:modelValue', {
      primary: 'ds.array',
      secondary: [],
    });
    api.saveProblem.mockRejectedValue({ status: 400, data: { error: '次要知识点最多 3 个' } });
    await flushPromises();
    await button(wrapper, '保存知识点').trigger('click');
    await flushPromises();
    expect(wrapper.find('.alert').text()).toBe('次要知识点最多 3 个');
  });
});
