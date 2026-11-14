import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, ref, watch } from 'vue';
import KnowledgeEditorPanel from '~/components/knowledge/KnowledgeEditorPanel.vue';

const graph = {
  pack: { id: 'official', version: '1' },
  areas: [{ id: 'ds', name: '数据结构', sort: 1 }],
  nodes: [
    { id: 'ds.array', area: 'ds', name: '数组', summary: null, requires: [] },
    { id: 'ds.list', area: 'ds', name: '链表', summary: null, requires: [] },
  ],
};

const view = (passRatio: number | null = null) => ({
  problem_id: 'p2',
  state: 'classified' as const,
  primary: {
    node_id: 'ds.array',
    name: '数组',
    role: 'primary' as const,
    source: 'human' as const,
    confidence: null,
    review_status: 'confirmed' as const,
    version_id: null,
    updated_at: '',
  },
  secondary: [],
  pending: false,
  difficulty: { score: 55, tier: 'medium' as const, sample_size: 4, pass_ratio_override: passRatio },
});

const loadProblem = vi.fn();
const saveProblem = vi.fn();
const loadGraph = vi.fn(() => Promise.resolve(graph));

const stubs = {
  UCard: { template: '<div><slot /></div>' },
  UButton: {
    props: ['disabled', 'loading', 'variant'],
    emits: ['click'],
    template:
      '<button :data-ghost="variant === \'ghost\' ? \'\' : undefined" :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  UAlert: { props: ['title'], template: '<p class="alert">{{ title }}</p>' },
  UBadge: { template: '<span><slot /></span>' },
  UInput: {
    props: ['modelValue', 'id', 'type'],
    emits: ['update:modelValue'],
    template:
      '<input :id="id" :type="type" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
};

async function panel() {
  const wrapper = mount(KnowledgeEditorPanel, {
    props: { problemId: 'p2', writable: true },
    global: { stubs },
    attachTo: document.body,
  });
  await flushPromises();
  return wrapper;
}

const ratioInput = (wrapper: Awaited<ReturnType<typeof panel>>) => wrapper.get('#knowledge-pass-ratio');
/** 主保存按钮：它是唯一带 `loading` 属性的 UButton（「放弃修改」没有）。 */
const saveButton = (wrapper: Awaited<ReturnType<typeof panel>>) => wrapper.get('button:not([data-ghost])');

beforeEach(() => {
  vi.clearAllMocks();
  for (const [name, value] of Object.entries({ computed, ref, watch })) vi.stubGlobal(name, value);
  vi.stubGlobal('useKnowledge', () => ({
    disabled: ref(false),
    graph: ref(graph),
    loadProblem,
    loadGraph,
    saveProblem,
    loadNode: vi.fn(),
    loadLadder: vi.fn(),
    loadNextForProblem: vi.fn(),
  }));
  loadProblem.mockResolvedValue(view());
  vi.stubGlobal('extractApiError', (error: unknown) => ({ message: String((error as Error)?.message ?? error) }));
  saveProblem.mockResolvedValue(view(75));
});

describe('题目编辑页知识点区块的及格线', () => {
  it('回填已有及格线覆盖值', async () => {
    loadProblem.mockResolvedValue(view(75));
    const wrapper = await panel();
    expect((ratioInput(wrapper).element as HTMLInputElement).value).toBe('75');
  });

  it('填写及格线后保存，随 PUT 提交 pass_ratio_override', async () => {
    const wrapper = await panel();
    expect(saveButton(wrapper).attributes('disabled')).toBeDefined();
    await ratioInput(wrapper).setValue('75');
    expect(wrapper.text()).toContain('有未保存的知识点修改');
    await saveButton(wrapper).trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('知识点已保存');
  });

  it('清空后保存提交 null（改用空间默认）', async () => {
    loadProblem.mockResolvedValue(view(75));
    const wrapper = await panel();
    await ratioInput(wrapper).setValue('');
    await saveButton(wrapper).trigger('click');
    await flushPromises();
    expect(saveProblem).toHaveBeenCalledWith('p2', { primary: 'ds.array', secondary: [] }, { passRatioOverride: null });
  });

  it('越界值拦截保存并提示', async () => {
    const wrapper = await panel();
    await ratioInput(wrapper).setValue('150');
    expect(wrapper.text()).toContain('请填写 0–100 的整数百分比');
    await saveButton(wrapper).trigger('click');
    await flushPromises();
    expect(saveProblem).not.toHaveBeenCalled();
  });
});
