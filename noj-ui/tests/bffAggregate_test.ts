// deno-lint-ignore no-import-prefix -- 与既有 Deno 测试一致，由 deno.lock 固定断言库版本
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@^1';
import { aggregateView } from '../server/utils/bff-aggregate.ts';
import { BffError, type CoreReader } from '../server/utils/bff-request.ts';
import { bffViewRoute } from '../utils/bff-view.ts';

function fixture(role: 'guest' | 'student' | 'coach' | 'assistant' = 'guest', community = false) {
  const calls: string[] = [];
  const workspace = {
    actor_id: role === 'guest' ? null : role,
    slug: 'school',
    is_member: role !== 'guest',
    platform_admin: false,
    permissions: [],
    configuration: { features: { assignment: role !== 'guest', community } },
  };
  const reader: CoreReader = {
    get<T>(path: string): Promise<T> {
      calls.push(path);
      const pathname = new URL(path, 'http://core').pathname;
      let data: unknown = { data: [] };
      if (pathname === '/api/v1/auth/me') data = { data: { id: role, must_change_password: false } };
      else if (pathname === '/api/v1/domains/school') data = { data: workspace };
      else if (pathname.endsWith('/classrooms/c')) {
        data = {
          data: {
            id: 'c',
            membership: { role },
            capabilities: role === 'coach' ? ['progress:read', 'feedback:write', 'help:manage'] : [],
            manages_domain: role === 'coach',
          },
        };
      } else if (pathname.endsWith('/assignments/a')) {
        data = { data: { id: 'a', classroom_id: 'c', published_at: '2026-10-18' } };
      } else if (pathname.endsWith('/problems')) data = { items: [], total: 0 };
      else if (pathname.endsWith('/community/config')) {
        data = { data: { enabled: true, follows_enabled: true, moments_enabled: true } };
      }
      return Promise.resolve(data as T);
    },
    post<T>(path: string, body: unknown): Promise<T> {
      calls.push(`POST ${path}`);
      if (path.endsWith('/problem-summaries')) {
        const references = (body as { references: string[] }).references;
        return Promise.resolve({
          data: {
            items: references.map((reference) => ({
              reference,
              availability: 'available',
              title: '题名',
              kind: 'oi',
              answer_version_id: 'v1',
              answer_version: 1,
              progress: null,
            })),
          },
        } as T);
      }
      return Promise.resolve({ data: [] } as T);
    },
  };
  return { reader, calls, workspace };
}

Deno.test('BFF 匿名首页不读取身份、签到、教学和关注流，公共布局只载入一次', async () => {
  const { reader, calls } = fixture();
  let meta = 0;
  const result = await aggregateView(
    reader,
    { kind: 'home', slug: 'school', authenticated: false },
    () => Promise.resolve(++meta),
  );
  assertEquals(result.viewer, null);
  assertEquals(meta, 1);
  assert(!calls.some((path) => /auth\/me|checkin|my-learning|teaching|feed|notifications/.test(path)));
  assertEquals(calls.filter((path) => path === '/api/v1/domains/school').length, 1);
});

Deno.test('BFF 学生和教练成绩分支分开，助教无能力时不读取成绩和会话', async () => {
  for (const role of ['student', 'coach', 'assistant'] as const) {
    const { reader, calls } = fixture(role);
    await aggregateView(
      reader,
      { kind: 'assignment', slug: 'school', id: 'a', authenticated: true },
      () => Promise.resolve({ data: {} }),
    );
    assertEquals(calls.some((p) => p.includes('/progress?')), role === 'student');
    assertEquals(calls.some((p) => p.includes('/matrix?')), role === 'coach');
    assertEquals(calls.some((p) => p.includes('/help-requests?')), role !== 'assistant');
    assertEquals(calls.filter((p) => p === '/api/v1/auth/me').length, 1);
    assertEquals(calls.filter((p) => p.endsWith('/classrooms/c')).length, 1);
  }
});

Deno.test('BFF 通知深链所需数据随作业视图一起返回', async () => {
  const { reader, calls } = fixture('student');
  await aggregateView(reader, {
    kind: 'assignment',
    slug: 'school',
    id: 'a',
    authenticated: true,
    help: 'h',
    feedback: 'f',
    history: true,
  }, () => Promise.resolve({}));
  assert(calls.some((p) => p.endsWith('/help-requests/h?page=1')));
  assert(calls.some((p) => p.endsWith('/feedback/f')));
  assert(calls.some((p) => p.endsWith('/history?page=1')));
});

Deno.test('BFF 辅助模块 5xx 保留局部错误，必要主资源和 401 不降级', async () => {
  const { reader } = fixture();
  const original = reader.get;
  reader.get = (path, options) =>
    path.endsWith('/carousel/slides')
      ? Promise.reject(new BffError(503, { error: '轮播故障' }))
      : original(path, options);
  const result = await aggregateView(
    reader,
    { kind: 'home', slug: 'school', authenticated: false },
    () => Promise.resolve({}),
  );
  assertEquals(result.sections.carousel?.error?.statusCode, 503);
  assert(result.sections.activity?.data);
  reader.get = () => Promise.reject(new BffError(404, { error: '空间不存在' }));
  const missing = await assertRejects(
    () => aggregateView(reader, { kind: 'home', slug: 'school', authenticated: false }, () => Promise.resolve({})),
    BffError,
  );
  assertEquals(missing.statusCode, 404);
  const anonymous = await assertRejects(
    () =>
      aggregateView(
        reader,
        { kind: 'classroom', slug: 'school', id: 'c', authenticated: false },
        () => Promise.resolve({}),
      ),
    BffError,
  );
  assertEquals(anonymous.statusCode, 401);
});

Deno.test('BFF 精确路由匹配与跨域、账号、查询参数快照隔离', () => {
  assertEquals(bffViewRoute('/d/school/classrooms/c')?.kind, 'classroom');
  assertEquals(bffViewRoute('/d/school/classrooms/c/members'), null);
  assertEquals(bffViewRoute('/d/school/assignments/a')?.endpoint, '/api/bff/v1/domains/school/assignments/a/overview');
});

Deno.test('题单只补齐当前20题，保留顺序与未知进度，不向来源域读取', async () => {
  const { reader, calls } = fixture();
  const original = reader.get;
  reader.get = <T>(path: string, options?: { timeout?: number; anonymous?: boolean }): Promise<T> => {
    if (path.includes('/trainings/t')) {
      calls.push(path);
      return Promise.resolve(
        {
          data: {
            id: 't',
            title: '长题单',
            items: Array.from(
              { length: 100 },
              (_, position) => ({
                problem_id: String(position),
                position,
                display_ref: `main:${position}`,
                binding_id: 'b',
                resource_available: position !== 22,
              }),
            ),
          },
        } as T,
      );
    }
    return original(path, options);
  };
  reader.post = <T>(path: string, body: unknown): Promise<T> => {
    calls.push(`POST ${path}`);
    const references = (body as { references: string[] }).references;
    return Promise.resolve({
      data: {
        items: references.map((reference) =>
          reference.endsWith('21')
            ? {
              reference,
              availability: 'unavailable',
              title: null,
              kind: null,
              answer_version_id: null,
              answer_version: null,
              progress: null,
            }
            : {
              reference,
              availability: 'available',
              title: '题名',
              kind: 'oi',
              answer_version_id: 'v1',
              answer_version: 1,
              progress: null,
            }
        ),
      },
    } as T);
  };
  const envelope = await aggregateView(reader, {
    kind: 'training',
    slug: 'school',
    id: 't',
    authenticated: false,
    page: 2,
  }, () => Promise.resolve({}));
  const { data } = envelope.sections.training?.data as unknown as {
    data: import('../utils/domain-trainings.ts').TrainingView;
  };
  assertEquals(data.total, 100);
  assertEquals(data.items.length, 20);
  assertEquals(data.items[0]!.position, 20);
  assertEquals(data.items[0]!.title, '题名');
  assertEquals(data.items[0]!.progress, null);
  assertEquals(data.items[1]!.summary_error, true);
  assertEquals(calls.filter((p) => p.startsWith('POST ') && p.includes('/problem-summaries')).length, 1);
  assert(!calls.some((p) => p.includes('/problems/')));
  assert(!calls.some((p) => p.startsWith('/api/v1/domains/main')));
  assert(!JSON.stringify(envelope.sections.training).includes('statistics'));
});
