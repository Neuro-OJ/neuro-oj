import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, onMounted, onUnmounted, ref, Suspense, watch } from 'vue';
import ContestPage from '~/pages/d/[slug]/contests/[contestId]/index.vue';

/**
 * 域比赛详情/报名页的状态机与信息完整性。
 *
 * 页面把「未登录 / 未报名 / 已报名 / 未开始 / 已结束 / 组织者」收敛到
 * `utils/contestWindow.ts` 的状态机，这里逐个状态验证渲染结果，并锁定
 * 「不展示赛题给未报名者」「结束后不再显示报名」等规则。
 */

const api = { detail: vi.fn(), problems: vi.fn(), register: vi.fn() };
let polling: Array<{ intervalMs: { value: number | null }; fetcher: () => Promise<unknown> }> = [];
let loggedIn = true;

function contest(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: 'contest',
      public_id: 'ct-demo',
      title: '班级联赛体验：判断题热身',
      description: '预览一班与预览二班联合热身赛。',
      announcement: '',
      start_time: '2026-10-27T05:13:16.098Z',
      end_time: '2026-11-03T05:14:16.098Z',
      type: 'kaggle',
      kind: 'public',
      config: { scoreboard_scope: 'self' },
      is_public: true,
      has_password: false,
      ranking_visibility: 'public',
      freeze_start_time: null,
      freeze_duration_seconds: 0,
      affect_global_ranking: false,
      status: 'running',
      problem_count: 1,
      participant_count: 2,
      is_registered: true,
      can_manage: false,
      classrooms: [],
      updated_at: '2026-10-27T05:14:16.111Z',
      ...overrides,
    },
  };
}

const stubs = {
  AsyncContent: { props: ['status', 'error'], template: '<div><p v-if="error">{{ error }}</p><slot /></div>' },
  UButton: {
    props: ['to', 'disabled'],
    emits: ['click'],
    template: '<button :data-to="to" @click="$emit(\'click\')"><slot /></a>'.replace('</a>', '</button>'),
  },
  UBadge: { template: '<span><slot /></span>' },
  UAlert: { props: ['title'], template: '<p>{{ title }}<slot name="actions" /></p>' },
  UInput: {
    props: ['modelValue', 'placeholder'],
    emits: ['update:modelValue'],
    template: '<input :placeholder="placeholder" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  MarkdownRenderer: { props: ['content'], template: '<div>{{ content }}</div>' },
  NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' },
};

async function view() {
  const Wrapper = defineComponent({
    setup: () => () => h(Suspense, null, { default: () => h(ContestPage) }),
  });
  const wrapper = mount(Wrapper, { global: { stubs } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  polling = [];
  loggedIn = true;
  for (const [name, value] of Object.entries({ computed, ref, watch, onMounted, onUnmounted })) {
    vi.stubGlobal(name, value);
  }
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal('useRoute', () => ({ params: { contestId: 'contest' }, fullPath: '/d/school/contests/contest' }));
  vi.stubGlobal('useAuth', () => ({ user: ref(loggedIn ? { id: 'student' } : null), isLoggedIn: ref(loggedIn) }));
  vi.stubGlobal('useWorkspace', () => ({ slug: ref('school') }));
  vi.stubGlobal('useWorkspaceActionScope', () => () => ({ slug: 'school', isCurrent: () => true }));
  vi.stubGlobal('useDomainContests', () => api);
  vi.stubGlobal('usePolling', (options: (typeof polling)[number]) => polling.push(options));
  vi.stubGlobal('useAsyncData', async (_key: unknown, load: () => Promise<unknown>) => {
    const data = ref<unknown>(null), error = ref<unknown>(null), status = ref('success');
    const refresh = async () => {
      try {
        data.value = await load();
        error.value = null;
      } catch (cause) {
        error.value = cause;
      }
    };
    await refresh();
    return { data, error, status, refresh };
  });
  api.problems.mockResolvedValue({
    data: [{
      problem_id: 'p1',
      label: 'A',
      title: '版本演示：判断题',
      display_id: '1001',
      version: 2,
      score: 10000,
      judge_type: 'dual',
      user_status: 'untouched',
    }],
  });
  api.register.mockResolvedValue({ message: 'ok' });
});

describe('比赛详情页的报名状态机', () => {
  it('已报名：展示参赛身份、赛题与进入入口，不再显示报名按钮', async () => {
    api.detail.mockResolvedValue(contest());
    const page = await view();
    expect(page.text()).toContain('你已报名本场比赛');
    expect(page.text()).toContain('版本演示：判断题');
    expect(page.text()).not.toContain('报名参赛');
    expect(page.findAll('button').some((button) => button.attributes('data-to')?.endsWith('/problems/A'))).toBe(true);
    expect(api.problems).toHaveBeenCalled();
    page.unmount();
  });

  it('未登录：引导登录，不请求赛题也不显示报名表单', async () => {
    loggedIn = false;
    api.detail.mockResolvedValue(contest({ is_registered: false }));
    const page = await view();
    expect(page.text()).toContain('登录后报名');
    expect(page.text()).not.toContain('邀请码');
    expect(api.problems).not.toHaveBeenCalled();
    page.unmount();
  });

  it('未报名且已开赛：提示报名后可查看赛题，不泄露题目标题', async () => {
    api.detail.mockResolvedValue(contest({ is_registered: false }));
    const page = await view();
    expect(page.text()).toContain('报名参赛');
    expect(page.text()).toContain('报名后可查看赛题');
    expect(page.text()).not.toContain('版本演示：判断题');
    expect(api.problems).not.toHaveBeenCalled();
    page.unmount();
  });

  it('历史比赛分类不再要求报名凭据', async () => {
    api.detail.mockResolvedValue(contest({ is_registered: false, kind: 'invite', has_password: true }));
    const page = await view();
    expect(page.find('input[type=password]').exists()).toBe(false);
    expect(page.text()).not.toContain('邀请码');
    // 头部与报名区各有一个「报名参赛」；点击报名区里的那个才真正提交。
    const buttons = page.findAll('button').filter((button) => button.text().includes('报名参赛'));
    expect(buttons.length).toBe(2);
    await buttons[1]!.trigger('click');
    await flushPromises();
    expect(api.register).toHaveBeenCalledWith('school', 'contest');
    page.unmount();
  });

  it('已结束：不再提供报名入口，赛题对所有人开放复盘', async () => {
    api.detail.mockResolvedValue(contest({ status: 'ended', is_registered: false }));
    const page = await view();
    expect(page.text()).toContain('比赛已结束');
    expect(page.text()).not.toContain('报名参赛');
    expect(page.text()).toContain('查看成绩');
    // 赛后未报名的域员也能看到赛题（后端已放开读取），报名通道关闭。
    expect(page.text()).toContain('版本演示：判断题');
    page.unmount();
  });

  it('未开始：说明赛题开赛后开放，仍展示赛程与赛制', async () => {
    api.detail.mockResolvedValue(contest({
      status: 'pending',
      is_registered: true,
      start_time: '2099-01-01T00:00:00.000Z',
      end_time: '2099-01-02T00:00:00.000Z',
    }));
    const page = await view();
    expect(page.text()).toContain('赛题在开赛后开放');
    expect(page.text()).toContain('距离开始还有');
    expect(page.text()).toContain('赛制与规则');
    expect(api.problems).not.toHaveBeenCalled();
    page.unmount();
  });
});

describe('比赛详情页的信息与实时性', () => {
  it('展示赛程、规模、榜单可见性与计分范围', async () => {
    api.detail.mockResolvedValue(contest({ freeze_duration_seconds: 3600, type: 'acm', affect_global_ranking: true }));
    const page = await view();
    expect(page.text()).toContain('比赛说明');
    expect(page.text()).toContain('封榜');
    expect(page.text()).toContain('本场成绩计入全局解题统计');
    expect(page.text()).toContain('榜单对所有人公开');
    page.unmount();
  });

  it('比赛结束后停止轮询，进行中按固定间隔刷新', async () => {
    api.detail.mockResolvedValue(contest());
    const page = await view();
    expect(polling[0]!.intervalMs.value).toBe(5000);
    api.detail.mockResolvedValue(contest({ status: 'ended' }));
    await polling[0]!.fetcher();
    await flushPromises();
    expect(polling[0]!.intervalMs.value).toBeNull();
    page.unmount();
  });
});
