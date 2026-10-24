// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assert, assertEquals, assertRejects, assertStringIncludes } from 'jsr:@std/assert@^1';
import { ApiError, loginPayload, request } from '../react/api.ts';
import { loadBootstrap } from '../react/bootstrap.ts';
import type { ServerGet } from '../react/bootstrap.ts';
import {
  draftKey,
  isProtectedRoute,
  isReactRoute,
  problemEndpoint,
  problemQuery,
  safeRedirect,
  submissionsQuery,
} from '../react/routes.ts';

Deno.test('React 路由仅接管首批路径，保留其他领域', () => {
  for (const path of ['/', '/login', '/problems', '/problems/P1', '/editor/P1', '/submissions', '/submissions/sb-1']) {
    assert(isReactRoute(path));
  }
  for (const path of ['/admin', '/contests', '/problems/new/coding', '/community', '/problems/P1/edit']) {
    assert(!isReactRoute(path));
  }
  assert(isProtectedRoute('/editor/P1'));
  assert(isProtectedRoute('/submissions'));
  assert(!isProtectedRoute('/problems/P1'));
});

Deno.test('React 登录回跳拒绝外站、协议相对路径、反斜线和控制字符', () => {
  for (const value of [null, 'https://evil.example', '//evil.example', '/\\evil.example', '/react\n', '/react\u0000']) {
    assertEquals(safeRedirect(value), '/react');
  }
  assertEquals(safeRedirect('/react/editor/P1?version_id=v2'), '/react/editor/P1?version_id=v2');
});

Deno.test('React API 查询限定合法筛选项并归一化页码', () => {
  assertEquals(
    problemQuery('?page=-2&keyword=图论&tag=t1&token=secret'),
    '/api/v1/problems?page=1&limit=20&keyword=%E5%9B%BE%E8%AE%BA&tag=t1',
  );
  assertStringIncludes(
    submissionsQuery('?page=2&status=finished&problem_id=uuid&token=secret'),
    'page=2&per_page=20&problem_id=uuid&status=finished',
  );
  assert(!submissionsQuery('?token=secret').includes('secret'));
  assertEquals(problemEndpoint('P1', '?version_id=a/b'), '/api/v1/problems/P1?version_id=a%2Fb');
});

Deno.test('React 草稿按账号、题目版本和语言隔离', () => {
  const keys = [
    draftKey('u1', 'p1', 'v1', 'python3'),
    draftKey('u2', 'p1', 'v1', 'python3'),
    draftKey('u1', 'p1', 'v2', 'python3'),
    draftKey('u1', 'p1', 'v1', 'cc'),
  ];
  assertEquals(new Set(keys).size, 4);
});

Deno.test('React 登录遵循原契约，省略未输入的验证码与未启用的记住我', () => {
  assertEquals(loginPayload({ login: ' user ', password: 'password', code: ' ', remember: false }), {
    login: 'user',
    password: 'password',
  });
  assertEquals(loginPayload({ login: 'user', password: 'password', code: ' 123456 ', remember: true }), {
    login: 'user',
    password: 'password',
    code: '123456',
    remember: true,
  });
});

Deno.test('React SSR 并发请求不会共享用户或资源数据', async () => {
  const get = (id: string): ServerGet => async <T>(url: string) => {
    await Promise.resolve();
    return (url.endsWith('/auth/me')
      ? { data: { id, username: id, email: `${id}@example.test`, is_admin: false, must_change_password: false } }
      : { data: { title: id } }) as T;
  };
  const [first, second] = await Promise.all([
    loadBootstrap('/react/problems/P1', true, get('first')),
    loadBootstrap('/react/problems/P1', true, get('second')),
  ]);
  assertEquals(first.user?.id, 'first');
  assertEquals(second.user?.id, 'second');
  assertEquals(first.resources['/api/v1/problems/P1'].data, { data: { title: 'first' } });
  assertEquals(second.resources['/api/v1/problems/P1'].data, { data: { title: 'second' } });
});

Deno.test('React SSR 未认证时不预取私有页面，认证故障不伪装成登出', async () => {
  const calls: string[] = [];
  const unavailable: ServerGet = (url) => {
    calls.push(url);
    throw new ApiError({ status: 503, message: '服务暂不可用' });
  };
  const anonymous = await loadBootstrap('/react/submissions', false, unavailable);
  assertEquals(calls, []);
  assertEquals(anonymous.resources, {});
  const transient = await loadBootstrap('/react/submissions', true, unavailable);
  assertEquals(calls, ['/api/v1/auth/me']);
  assertEquals(transient.authError?.status, 503);
  const unauthorized = await loadBootstrap('/react/submissions', true, () => {
    throw new ApiError({ status: 401, message: '未登录' });
  });
  assertEquals(unauthorized.authError, undefined);
});

Deno.test('React SSR 保留不可见题目的 404，首页可选接口失败不会改变页面状态', async () => {
  const missing: ServerGet = () => {
    throw new ApiError({ status: 404, message: '题目不存在' });
  };
  const detail = await loadBootstrap('/react/problems/P404?version_id=v1', false, missing);
  assertEquals(detail.status, 404);
  assertEquals(detail.resources['/api/v1/problems/P404?version_id=v1'].error?.status, 404);
  const home = await loadBootstrap('/react', false, missing);
  assertEquals(home.status, undefined);
});

Deno.test('React API 保留错误状态、业务码和请求编号', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      Response.json({ error: '版本已变更', code: 'PROBLEM_VERSION_CHANGED', request_id: 'r1' }, { status: 409 }),
    );
  try {
    const error = await assertRejects(
      () => request('/api/v1/submissions', { method: 'POST', body: { version_id: 'v1' } }),
      ApiError,
      '版本已变更',
    );
    assertEquals(error.info, { status: 409, message: '版本已变更', code: 'PROBLEM_VERSION_CHANGED', requestId: 'r1' });
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test('React 上传保留 FormData 和浏览器生成的 multipart 边界', async () => {
  const original = globalThis.fetch;
  let captured: RequestInit | undefined;
  globalThis.fetch = (_input, options) => {
    captured = options;
    return Promise.resolve(Response.json({ data: { id: 's1' } }));
  };
  try {
    const body = new FormData();
    body.append('version_id', 'v2');
    body.append('file', new Blob(['a,b']), 'prediction.csv');
    await request('/api/v1/submissions', { method: 'POST', body });
    assertEquals(captured?.body, body);
    assertEquals(captured?.headers, undefined);
    assertEquals(captured?.credentials, 'same-origin');
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test('React API 不向外站或非白名单路径发请求', async () => {
  await assertRejects(() => request('https://evil.example/api/v1/auth/me'), ApiError, '无效的 API 路径');
  await assertRejects(() => request('/metrics'), ApiError);
});
