import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, onMounted, reactive, ref } from 'vue';

const api: Record<string, ReturnType<typeof vi.fn>> = {
  loadUsage: vi.fn(),
  estimateBackfill: vi.fn(),
  backfill: vi.fn(),
  loadReviews: vi.fn(),
  decideReview: vi.fn(),
  loadGraph: vi.fn(),
  loadProblem: vi.fn(),
  saveProblem: vi.fn(),
};
const disabled = ref(false);
const confirm = vi.fn();

const usage = {
  month_start: '2026-11-01T00:00:00.000Z',
  input_tokens: 1000,
  output_tokens: 500,
  total_tokens: 1500,
  requests: 3,
  cost: 0,
  budget: 2000000,
  remaining: 1998500,
  ai_tagging_enabled: true,
  model_alias: 'platform.tagger',
  alias_configured: true,
  gateway_error: null,
  offpeak: {
    enabled: true,
    window: '00:30-08:30',
    next_start: '2026-11-13T16:30:00.000Z',
  },
};
const offpeakEstimate = {
  enabled: true,
  window: '00:30-08:30',
  next_start: '2026-11-13T16:30:00.000Z',
};
const review = {
  problem_id: '11111111-1111-1111-1111-111111111111',
  title: '两数之和',
  domain_id: 'main',
  primary: {
    node_id: 'ds.array',
    name: '数组',
    role: 'primary',
    source: 'ai',
    confidence: 62,
    review_status: 'pending',
    version_id: null,
    updated_at: '',
  },
  secondary: [{
    node_id: 'alg.greedy',
    name: '贪心',
    role: 'secondary',
    source: 'ai',
    confidence: 62,
    review_status: 'pending',
    version_id: null,
    updated_at: '',
  }],
  updated_at: '',
};

beforeEach(() => {
  vi.clearAllMocks();
  disabled.value = false;
  for (const [name, value] of Object.entries({ computed, reactive, ref, onMounted })) vi.stubGlobal(name, value);
  vi.stubGlobal('useKnowledge', () => ({
    disabled,
    graph: ref({
      pack: null,
      areas: [{ id: 'ds', name: '数据结构', sort: 1 }],
      nodes: [{ id: 'ds.array', area: 'ds', name: '数组', summary: null, requires: [] }],
    }),
    ...api,
  }));
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useDialog', () => ({ dialog: { confirm } }));
  api.loadUsage.mockResolvedValue(usage);
  api.loadReviews.mockResolvedValue({ items: [review], total: 1, page: 1, limit: 20 });
  api.loadGraph.mockResolvedValue(null);
  confirm.mockResolvedValue(true);
});

async function view() {
  const { default: Page } = await import('~/pages/admin/knowledge.vue');
  const Wrapper = defineComponent({ setup: () => () => h(Page) });
  const wrapper = mount(Wrapper, {
    global: {
      stubs: {
        AdminPageHeader: { props: ['title'], template: '<h1>{{ title }}</h1>' },
        AdminTable: {
          props: ['columns', 'items', 'loading', 'error', 'totalPages', 'currentPage'],
          template:
            '<div class="table"><slot name="empty" /><div v-for="row in items" :key="row.problem_id" class="row"><slot name="cell" :row="row" :column="{ key: \'title\' }" /><slot name="cell" :row="row" :column="{ key: \'actions\' }" /></div></div>',
        },
        UAlert: { props: ['title', 'description'], template: '<p class="alert">{{ title }}{{ description }}</p>' },
        UBadge: { template: '<span class="badge"><slot /></span>' },
        UButton: {
          props: ['disabled', 'loading', 'title'],
          emits: ['click'],
          template: '<button :disabled="disabled" :title="title" @click="$emit(\'click\')"><slot /></button>',
        },
        UIcon: true,
        NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
        UModal: {
          props: ['open'],
          template: '<div v-if="open" class="modal"><slot name="body" /><slot name="footer" /></div>',
        },
        KnowledgePicker: {
          props: ['modelValue'],
          emits: ['update:modelValue'],
          template:
            '<div class="picker"><button type="button" class="pick" @click="$emit(\'update:modelValue\', { primary: \'ds.array\', secondary: [] })">选中</button></div>',
        },
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

describe('管理后台知识图谱页', () => {
  it('展示本月用量、预算、剩余与别名配置状态，并链接到设置页分类', async () => {
    const wrapper = await view();
    const usageCard = wrapper.get('[data-testid="kg-usage"]');
    expect(usageCard.text()).toContain('1,500');
    expect(usageCard.text()).toContain('2,000,000');
    expect(usageCard.text()).toContain('1,998,500');
    expect(usageCard.text()).toContain('已配置');
    expect(usageCard.text()).toContain('开关：已开启');
    expect(usageCard.find('a').attributes('href')).toBe('/admin/settings?category=knowledge');
    // 低峰时段：开/关、北京时间时段、下次开始（按北京时间展示）。
    const offpeak = usageCard.get('[data-testid="kg-offpeak"]').text();
    expect(offpeak).toContain('仅低峰时段打标：开');
    expect(offpeak).toContain('时段 00:30–08:30（北京时间）');
    expect(offpeak).toContain('下次开始');
    expect(offpeak).toContain('11/14');
    expect(offpeak).not.toMatch(/折扣|优惠\s*\d/);
    expect(wrapper.text()).toContain('两数之和');
    expect(wrapper.text()).toContain('没有待审核的 AI 建议');
  });

  it('KNOWLEDGE_DISABLED 时整块隐藏，只显示关闭提示', async () => {
    disabled.value = true;
    api.loadUsage.mockImplementation(() => {
      disabled.value = true;
      return Promise.resolve(null);
    });
    const wrapper = await view();
    expect(wrapper.text()).toContain('知识图谱功能已关闭');
    expect(wrapper.find('[data-testid="kg-usage"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="kg-reviews"]').exists()).toBe(false);
    expect(api.loadReviews).not.toHaveBeenCalled();
  });

  it('未预估前不能回填；预估后确认框带数量与费用，null 费用显示未知', async () => {
    const wrapper = await view();
    expect(button(wrapper, '确认回填').attributes('disabled')).toBeDefined();
    api.estimateBackfill.mockResolvedValue({
      expected_count: 12,
      avg_user_chars: 900,
      prefix_chars: 5000,
      estimated_input_tokens: 40000,
      estimated_output_tokens: 3600,
      estimated_total_tokens: 43600,
      monthly_budget: 2000000,
      estimated_cost: null,
      cost_note: '网关未暴露单价',
      offpeak: offpeakEstimate,
    });
    await button(wrapper, '预估').trigger('click');
    await flushPromises();
    const backfillCard = wrapper.get('[data-testid="kg-backfill"]');
    expect(backfillCard.text()).toContain('12');
    expect(backfillCard.text()).toContain('未知');
    expect(backfillCard.text()).toContain('43,600');
  });

  it('确认后带 expected_count 回填；409 提示重新预估且不再可回填', async () => {
    const wrapper = await view();
    api.estimateBackfill.mockResolvedValue({
      expected_count: 12,
      avg_user_chars: 0,
      prefix_chars: 0,
      estimated_input_tokens: 1,
      estimated_output_tokens: 1,
      estimated_total_tokens: 2,
      monthly_budget: 100,
      estimated_cost: 0.5,
      cost_note: '',
      offpeak: offpeakEstimate,
    });
    api.backfill.mockResolvedValue({ data: null, drifted: true });
    await button(wrapper, '预估').trigger('click');
    await flushPromises();
    await button(wrapper, '确认回填').trigger('click');
    await flushPromises();
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('12'), expect.anything());
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('任务将在低峰时段执行'), expect.anything());
    expect(api.backfill).toHaveBeenCalledWith(12);
    expect(wrapper.get('[data-testid="kg-backfill"]').text()).toContain('请重新预估');
    expect(button(wrapper, '确认回填').attributes('disabled')).toBeDefined();
  });

  it('取消确认对话框不投递回填', async () => {
    const wrapper = await view();
    api.estimateBackfill.mockResolvedValue({
      expected_count: 1,
      offpeak: offpeakEstimate,
      avg_user_chars: 0,
      prefix_chars: 0,
      estimated_input_tokens: 1,
      estimated_output_tokens: 1,
      estimated_total_tokens: 2,
      monthly_budget: 100,
      estimated_cost: null,
      cost_note: '',
    });
    confirm.mockResolvedValueOnce(false);
    await button(wrapper, '预估').trigger('click');
    await flushPromises();
    await button(wrapper, '确认回填').trigger('click');
    await flushPromises();
    expect(api.backfill).not.toHaveBeenCalled();
  });

  it('审核队列通过/驳回调用对应决定，修改打开选择器保存人工挂载', async () => {
    const wrapper = await view();
    api.decideReview.mockResolvedValue(null);
    await button(wrapper, '通过').trigger('click');
    await flushPromises();
    expect(api.decideReview).toHaveBeenCalledWith(review.problem_id, 'accept');
    await button(wrapper, '驳回').trigger('click');
    await flushPromises();
    expect(api.decideReview).toHaveBeenCalledWith(review.problem_id, 'reject');
    await button(wrapper, '修改').trigger('click');
    await flushPromises();
    expect(wrapper.find('.modal .picker').exists()).toBe(true);
    // 预填自 AI 建议的主知识点，直接保存即人工修改
    await wrapper.get('.modal .picker .pick').trigger('click');
    api.decideReview.mockResolvedValue(null);
    const saves = wrapper.findAll('.modal button').filter((item) => item.text() === '保存');
    await saves[0].trigger('click');
    await flushPromises();
    expect(api.decideReview).toHaveBeenLastCalledWith(review.problem_id, { primary: 'ds.array', secondary: [] });
  });
});
