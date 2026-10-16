import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { computed, defineComponent, h, onMounted, onUnmounted, reactive, ref, Suspense, watch } from 'vue';
import { useDomainSubmissions } from '~/composables/useDomainSubmissions';
import { type QueueData, type QueueScope, useDomainQueue } from '~/composables/useDomainQueue';
import QueueRow from '~/components/feature/QueueRow.vue';
import SubmissionsPage from '~/pages/d/[slug]/submissions/index.vue';
import QueuePage from '~/pages/d/[slug]/queue.vue';
import LegacyQueuePage from '~/pages/queue.vue';
import LegacyObjectiveSubmissionsPage from '~/pages/d/[slug]/objective-submissions/index.vue';

const getMock = vi.fn();
const routerPush = vi.fn();
const routerReplace = vi.fn();
let currentRoute: { fullPath: string; query: Record<string, string | undefined>; params: Record<string, string> };
const user = ref<{ id: string; username: string } | null>({ id: 'u1', username: 'student' });
const slug = ref('school');

const stubs = {
  AdminPageHeader: {
    name: 'AdminPageHeader',
    props: ['title', 'description', 'icon'],
    template: '<header><slot /><slot name="actions" /></header>',
  },
  UButton: {
    name: 'UButton',
    props: ['to', 'loading', 'disabled'],
    template: '<button :data-to="to" @click="$emit(\'click\')"><slot /></button>',
  },
  UInput: {
    name: 'UInput',
    props: ['modelValue', 'placeholder'],
    template:
      '<input :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" @keyup.enter="$emit(\'keyup.enter\')" />',
  },
  USelect: {
    name: 'USelect',
    props: ['modelValue', 'items'],
    template:
      '<select :value="modelValue" @change="$emit(\'update:modelValue\', $event.target.value)"><option v-for="item in items" :key="item.value" :value="item.value">{{ item.label }}</option></select>',
  },
  UTable: {
    name: 'UTable',
    props: ['data', 'columns'],
    template: `
      <table>
        <tbody>
          <tr v-for="(row, idx) in data" :key="idx">
            <td><slot name="id-cell" :row="{ original: row }" /></td>
            <td><slot name="problem-cell" :row="{ original: row }" /></td>
            <td><slot name="user-cell" :row="{ original: row }" /></td>
            <td><slot name="type_lang-cell" :row="{ original: row }" /></td>
            <td><slot name="result-cell" :row="{ original: row }" /></td>
            <td><slot name="version-cell" :row="{ original: row }" /></td>
            <td><slot name="created_at-cell" :row="{ original: row }" /></td>
          </tr>
        </tbody>
      </table>
    `,
  },
  UAlert: {
    name: 'UAlert',
    props: ['title', 'description', 'color'],
    template: '<div role="alert"><p>{{ title }}</p><p>{{ description }}</p></div>',
  },
  UBadge: {
    name: 'UBadge',
    template: '<span><slot /></span>',
  },
  UCard: {
    name: 'UCard',
    template: '<div><slot /></div>',
  },
  UIcon: true,
  NuxtLink: {
    name: 'NuxtLink',
    props: ['to'],
    template: '<a :href="to"><slot /></a>',
  },
  PaginationNav: true,
  AsyncContent: {
    name: 'AsyncContent',
    props: ['status', 'error', 'emptyText'],
    template:
      '<div><p v-if="error">{{ error }}</p><p v-else-if="status===\'empty\'">{{ emptyText }}</p><slot v-else /></div>',
  },
  DomainSubmissionStatus: {
    name: 'DomainSubmissionStatus',
    props: ['submission'],
    template:
      '<span data-testid="status">{{ submission.result_visibility === "hidden" ? "已受理" : (submission.result?.verdict || "已完成") }} {{ submission.result?.score != null ? submission.result.score / 100 + "分" : "" }}</span>',
  },
  QueueRow: {
    name: 'QueueRow',
    props: ['item', 'now', 'showElapsed', 'showScore'],
    template: '<div><span>{{ item.id }}</span><span>{{ item.problem_title }}</span></div>',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  getMock.mockReset();
  currentRoute = reactive({ fullPath: '/d/school/submissions', query: {}, params: { slug: 'school' } });
  slug.value = 'school';
  user.value = { id: 'u1', username: 'student' };

  for (const [name, value] of Object.entries({ computed, ref, watch, onMounted, onUnmounted, reactive })) {
    vi.stubGlobal(name, value);
  }
  vi.stubGlobal('definePageMeta', vi.fn());
  vi.stubGlobal('useSeoMeta', vi.fn());
  vi.stubGlobal('useRoute', () => currentRoute);
  vi.stubGlobal('useRouter', () => ({
    push: (target: { query: Record<string, string | undefined> }) => {
      routerPush(target);
      currentRoute.query = { ...target.query };
    },
    replace: (target: { query: Record<string, string | undefined> }) => {
      routerReplace(target);
      currentRoute.query = { ...target.query };
    },
  }));
  vi.stubGlobal('useWorkspace', () => ({ slug }));
  vi.stubGlobal('useAuth', () => ({ user }));
  vi.stubGlobal('useApi', () => ({ api: { get: getMock } }));
  vi.stubGlobal('useEventSource', vi.fn());
  vi.stubGlobal('useAsyncData', async (_key: unknown, fetcher: () => Promise<unknown>) => {
    const data = ref<unknown>(null);
    const error = ref<unknown>(null);
    const status = ref('pending');
    try {
      data.value = await fetcher();
      status.value = 'success';
    } catch (e) {
      error.value = e;
      status.value = 'error';
    }
    const refresh = async () => {
      try {
        data.value = await fetcher();
        status.value = 'success';
      } catch (e) {
        error.value = e;
        status.value = 'error';
      }
    };
    return { data, error, status, refresh };
  });
});

describe('useDomainSubmissions 契约调用', () => {
  it('支持传参 username、kind、problem_id 与 contest_id，并保留空字符串 username', async () => {
    getMock.mockResolvedValue({ data: [], pagination: { total: 0, total_pages: 1 } });
    const api = useDomainSubmissions();

    await api.list('school', 1, { username: '', kind: 'objective' });
    expect(getMock).toHaveBeenCalledWith('/api/v1/domains/school/submissions', {
      query: { page: 1, per_page: 30, username: '', kind: 'objective' },
      silent: true,
    });

    await api.list('school', 2, { username: 'alice', kind: 'code', problem_id: 'p1', contest_id: 'c1' });
    expect(getMock).toHaveBeenCalledWith('/api/v1/domains/school/submissions', {
      query: { page: 2, per_page: 30, username: 'alice', kind: 'code', problem_id: 'p1', contest_id: 'c1' },
      silent: true,
    });
  });
});

describe('useDomainQueue 契约调用', () => {
  it('按 domain 与 instance scope 正确调用对应路径与 SSE 端点', async () => {
    getMock.mockResolvedValue({
      pending: [],
      judging: [],
      recently_completed: [],
      stats: { pending_count: 0, judging_count: 0, completed_today: 0 },
    });
    const api = useDomainQueue();

    await api.getQueue('school', 'domain');
    expect(getMock).toHaveBeenCalledWith('/api/v1/domains/school/queue', { silent: true });
    expect(api.sseUrl('school', 'domain')).toBe('/api/v1/domains/school/queue/events');

    await api.getQueue('school', 'instance');
    expect(getMock).toHaveBeenCalledWith('/api/v1/instance/queue', { silent: true });
    expect(api.sseUrl('school', 'instance')).toBe('/api/v1/instance/queue/events');
  });
});

describe('QueueRow 任务跳转与自测展示', () => {
  it('保留条目的 domain_slug 跳转对应空间详情，自测不造不可用链接', () => {
    const submissionItem = {
      id: 'sub12345678',
      public_id: 'sub-pub',
      problem_id: '1001',
      problem_title: 'A+B Problem',
      language: 'cpp',
      submitted_by: 'student',
      submitted_at: '2026-10-16T00:00:00Z',
      domain_slug: 'team-a',
      kind: 'submission' as const,
    };
    const viewSub = mount(QueueRow, {
      props: { item: submissionItem, now: Date.now() },
      global: { stubs },
    });
    const subLink = viewSub.find('a');
    expect(subLink.exists()).toBe(true);
    expect(subLink.attributes('href')).toBe('/d/team-a/submissions/sub-pub');
    expect(viewSub.text()).toContain('@team-a');

    const selfTestItem = {
      id: 'st-12345678',
      public_id: 'st-pub',
      problem_id: '1001',
      problem_title: 'A+B Problem',
      language: 'python3',
      submitted_by: 'student',
      submitted_at: '2026-10-16T00:00:00Z',
      domain_slug: 'school',
      kind: 'self_test' as const,
    };
    const viewTest = mount(QueueRow, {
      props: { item: selfTestItem, now: Date.now() },
      global: { stubs },
    });
    expect(viewTest.find('a').exists()).toBe(false);
    expect(viewTest.text()).toContain('自测');
  });
});

describe('统一提交列表页面', () => {
  it('默认回填本人用户名，清空后 URL 保留空串，刷新后不恢复为本人', async () => {
    const listMock = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'sub-1',
          kind: 'submission',
          domain_id: 'd1',
          username: 'student',
          language: 'python3',
          created_at: '2026-10-16T00:00:00Z',
          reference: { display_ref: '1001' },
          problem: { title: '测试题目' },
          resource_available: true,
          status: 'finished',
          result_visibility: 'cases',
          result: { status: 'finished', verdict: 'AC', score: 10000 },
        },
        {
          id: 'obj-1',
          kind: 'objective',
          domain_id: 'd1',
          username: 'student',
          created_at: '2026-10-16T00:00:00Z',
          reference: { display_ref: '1002' },
          problem: { title: '客观选择题' },
          resource_available: true,
          status: 'finished',
          result_visibility: 'summary',
          result: { status: 'finished', score: 8000 },
        },
      ],
      pagination: { total: 2, total_pages: 1 },
    });
    vi.stubGlobal('useDomainSubmissions', () => ({ list: listMock, detail: vi.fn() }));

    const view = mount(
      defineComponent({
        setup: () => () => h(Suspense, null, { default: () => h(SubmissionsPage) }),
      }),
      { global: { stubs } },
    );
    await flushPromises();

    // 默认回填本人并在初次挂载时同步到 URL
    expect(listMock).toHaveBeenCalledWith('school', 1, expect.objectContaining({ username: 'student' }));
    expect(routerReplace).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ username: 'student' }) }),
    );

    // 点击链接按题型分别跳转普通详情与客观题详情
    const links = view.findAll('a').map((a) => a.attributes('href'));
    expect(links).toContain('/d/school/submissions/sub-1');
    expect(links).toContain('/d/school/objective-submissions/obj-1');

    // 清空用户名后，URL 保存空字符串
    const clearBtn = view.findAllComponents({ name: 'UButton' }).find((b) => b.text().includes('清空'));
    expect(clearBtn).toBeDefined();
    await clearBtn!.trigger('click');
    await flushPromises();
    expect(routerPush).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ username: '' }) }),
    );

    // 模拟带着 username="" 刷新页面，此时 route.query.username 为 ""，不会回退为本人
    currentRoute.query = { username: '' };
    const _refreshView = mount(
      defineComponent({
        setup: () => () => h(Suspense, null, { default: () => h(SubmissionsPage) }),
      }),
      { global: { stubs } },
    );
    await flushPromises();
    expect(listMock).toHaveBeenCalledWith('school', 1, expect.objectContaining({ username: '' }));
  });

  it('比赛 hidden 状态不渲染成绩，也不反推判定结果', async () => {
    const listMock = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'sub-hidden',
          kind: 'submission',
          domain_id: 'd1',
          username: 'student',
          language: 'cpp',
          created_at: '2026-10-16T00:00:00Z',
          reference: { display_ref: '1003' },
          problem: { title: '保密赛题' },
          resource_available: true,
          status: 'submitted',
          result_visibility: 'hidden',
          result: null,
        },
      ],
      pagination: { total: 1, total_pages: 1 },
    });
    vi.stubGlobal('useDomainSubmissions', () => ({ list: listMock, detail: vi.fn() }));

    const view = mount(
      defineComponent({
        setup: () => () => h(Suspense, null, { default: () => h(SubmissionsPage) }),
      }),
      { global: { stubs } },
    );
    await flushPromises();

    expect(view.text()).toContain('已受理');
    expect(view.text()).not.toContain('AC');
    expect(view.text()).not.toContain('分');
  });
});

describe('评测队列页面', () => {
  it('支持当前域与实例切分，实例模式提供授权任务说明且标注共享池为实例资源', async () => {
    const queueData = {
      pending: [],
      judging: [],
      recently_completed: [],
      stats: {
        pending_count: 5,
        judging_count: 2,
        completed_today: 10,
        pools: {
          'oi-wasm': { pending: 2, processing: 1, task_capacity: 10 },
          'ai': { pending: 3, processing: 1 },
        },
      },
    };
    const getQueueMock = vi.fn().mockResolvedValue(queueData);
    vi.stubGlobal('useDomainQueue', () => ({
      getQueue: getQueueMock,
      sseUrl: (s: string, sc: string) => `/api/v1/${sc === 'instance' ? 'instance' : `domains/${s}`}/queue/events`,
    }));

    currentRoute = reactive({ fullPath: '/d/school/queue', query: { scope: 'instance' }, params: { slug: 'school' } });
    const view = mount(
      defineComponent({
        setup: () => () => h(Suspense, null, { default: () => h(QueuePage) }),
      }),
      { global: { stubs } },
    );
    await flushPromises();

    // 实例模式调用 instance 接口
    expect(getQueueMock).toHaveBeenCalledWith('school', 'instance');
    // 实例模式提示文案
    expect(view.text()).toContain('明细仅显示你有权查看的任务');
    // 共享池标注为实例资源
    expect(view.text()).toContain('共享资源池（实例资源）');
  });

  it('刷新失败保留原有数据与更新时间', async () => {
    const initialData = {
      pending: [],
      judging: [],
      recently_completed: [],
      stats: { pending_count: 1, judging_count: 1, completed_today: 1 },
    };
    let count = 0;
    const getQueueMock = vi.fn().mockImplementation(() => {
      count++;
      if (count === 1) return Promise.resolve(initialData);
      return Promise.reject(new Error('网络中断'));
    });
    vi.stubGlobal('useDomainQueue', () => ({
      getQueue: getQueueMock,
      sseUrl: () => '/api/v1/domains/school/queue/events',
    }));

    currentRoute = reactive({ fullPath: '/d/school/queue', query: {}, params: { slug: 'school' } });
    const view = mount(
      defineComponent({
        setup: () => () => h(Suspense, null, { default: () => h(QueuePage) }),
      }),
      { global: { stubs } },
    );
    await flushPromises();

    expect(view.text()).toContain('排队中 1');

    // 触发刷新（count = 2，报错）
    const refreshBtn = view.findAllComponents({ name: 'UButton' }).find((b) =>
      b.attributes('aria-label') === '刷新队列'
    );
    await refreshBtn!.trigger('click');
    await flushPromises();

    // 数据仍然保留，并提示刷新失败保留上次成功数据
    expect(view.text()).toContain('排队中 1');
    expect(view.text()).toContain('已保留上次成功获取的数据');
  });

  it('切换 domain/instance 与 slug 时按当前 scopeKey 丢弃过时慢请求，不发生视图串扰', async () => {
    type Deferred<T> = {
      promise: Promise<T>;
      resolve: (val: T) => void;
      reject: (err: unknown) => void;
    };
    function createDeferred<T>(): Deferred<T> {
      let resolve!: (val: T) => void;
      let reject!: (err: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    const schoolDomainDeferred = createDeferred<QueueData>();
    const instanceDeferred = createDeferred<QueueData>();
    const collegeDomainDeferred = createDeferred<QueueData>();

    const schoolDomainData: QueueData = {
      pending: [
        {
          id: 'item-school-1',
          problem_id: 'p1',
          problem_title: '旧校区域任务',
          language: 'python3',
          submitted_at: '2026-10-16T00:00:00Z',
          submitted_by: 'student',
          kind: 'submission',
        },
      ],
      judging: [],
      recently_completed: [],
      stats: { pending_count: 99, judging_count: 0, completed_today: 0 },
    };

    const instanceData: QueueData = {
      pending: [
        {
          id: 'item-instance-1',
          problem_id: 'p2',
          problem_title: '全局实例任务',
          language: 'cpp',
          submitted_at: '2026-10-16T00:01:00Z',
          submitted_by: 'admin',
          kind: 'submission',
        },
      ],
      judging: [],
      recently_completed: [],
      stats: { pending_count: 1, judging_count: 0, completed_today: 0 },
    };

    const collegeDomainData: QueueData = {
      pending: [
        {
          id: 'item-college-1',
          problem_id: 'p3',
          problem_title: '新书院域任务',
          language: 'rust',
          submitted_at: '2026-10-16T00:02:00Z',
          submitted_by: 'teacher',
          kind: 'submission',
        },
      ],
      judging: [],
      recently_completed: [],
      stats: { pending_count: 5, judging_count: 0, completed_today: 0 },
    };

    const getQueueMock = vi.fn().mockImplementation((targetSlug: string, targetScope: QueueScope) => {
      if (targetScope === 'instance') {
        return instanceDeferred.promise;
      }
      if (targetSlug === 'college') {
        return collegeDomainDeferred.promise;
      }
      return schoolDomainDeferred.promise;
    });

    vi.stubGlobal('useDomainQueue', () => ({
      getQueue: getQueueMock,
      sseUrl: (s: string, sc: string) => `/api/v1/${sc === 'instance' ? 'instance' : `domains/${s}`}/queue/events`,
    }));

    // 初始处于 school 域且为 domain scope
    slug.value = 'school';
    currentRoute = reactive({ fullPath: '/d/school/queue', query: {}, params: { slug: 'school' } });

    const view = mount(
      defineComponent({
        setup: () => () => h(Suspense, null, { default: () => h(QueuePage) }),
      }),
      { global: { stubs } },
    );
    await flushPromises();

    // 初始发起 school domain 请求，保持慢速 pending
    expect(getQueueMock).toHaveBeenCalledWith('school', 'domain');

    // 1. 用户切换至实例视图（instance scope）
    const instanceBtn = view.findAll('button').find((b) => b.text().includes('实例'));
    expect(instanceBtn).toBeDefined();
    await instanceBtn!.trigger('click');
    await flushPromises();

    // 验证发出了 instance 请求
    expect(getQueueMock).toHaveBeenCalledWith('school', 'instance');

    // 后发起的 instance 请求快速响应完成
    instanceDeferred.resolve(instanceData);
    await flushPromises();

    // 视图已正确展示实例队列
    expect(view.text()).toContain('全局实例任务');
    expect(view.text()).toContain('排队中 1');
    expect(view.text()).not.toContain('旧校区域任务');

    // 此时先发但过时的 school domain 请求才慢速返回
    schoolDomainDeferred.resolve(schoolDomainData);
    await flushPromises();

    // 视图必须依然展示实例队列，绝不被延迟返回的 domain 数据覆盖
    expect(view.text()).toContain('全局实例任务');
    expect(view.text()).toContain('排队中 1');
    expect(view.text()).not.toContain('旧校区域任务');
    expect(view.text()).not.toContain('99');

    // 2. 接着测试切换域 slug：从当前视图切换到 college 域，并切换至当前域模式
    const domainBtn = view.findAll('button').find((b) => b.text().includes('当前域'));
    expect(domainBtn).toBeDefined();
    await domainBtn!.trigger('click');
    slug.value = 'college';
    await flushPromises();

    // 验证为 college 发起 domain 请求
    expect(getQueueMock).toHaveBeenCalledWith('college', 'domain');

    // college 请求响应完成
    collegeDomainDeferred.resolve(collegeDomainData);
    await flushPromises();

    // 视图正确展示新域 college 的数据，不包含旧视图数据
    expect(view.text()).toContain('新书院域任务');
    expect(view.text()).toContain('排队中 5');
    expect(view.text()).not.toContain('全局实例任务');
    expect(view.text()).not.toContain('旧校区域任务');
  });
});

describe('兼容重定向页面', () => {
  it('旧 /queue 页面渲染重定向状态提示', () => {
    const view = mount(LegacyQueuePage, { global: { stubs } });
    expect(view.text()).toContain('正在重定向至评测队列...');
  });

  it('旧 /d/:slug/objective-submissions 页面渲染重定向状态提示', () => {
    const view = mount(LegacyObjectiveSubmissionsPage, { global: { stubs } });
    expect(view.text()).toContain('正在重定向至客观题提交...');
  });
});
