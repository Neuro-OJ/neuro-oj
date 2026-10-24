/// <reference lib="dom" />
/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- 沿用项目固定的浏览器测试依赖
import { chromium, expect, type Page } from 'npm:playwright@1.62.0/test';

/**
 * 先以 NUXT_API_BASE=http://127.0.0.1:8071 启动 UI，再执行本任务。
 * 测试只连接此文件创建的本地夹具，不访问真实账号或评测服务。
 */
const uiUrl = Deno.env.get('E2E_UI_URL') ?? 'http://127.0.0.1:3072';
const screenshotDir = Deno.env.get('NOJ_REACT_SCREENSHOTS');
const user = {
  id: 'fixture-user',
  username: 'fixture',
  email: 'fixture@example.test',
  is_admin: false,
  must_change_password: false,
};
const token = `fixture.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 30 * 86400 }))}.fixture`;
const problem = {
  id: 'fixture-problem',
  display_id: 'P1',
  title: '线性回归',
  description: '# 题目描述\n\n完成 `solve()`，输出预测结果。\n\n$x^2$\n\n<script>globalThis.fixtureXss=true</script>',
  difficulty: 'easy',
  type: 'P',
  owner_id: 'owner',
  tags: [],
  is_objective: false,
  submission_mode: 'code',
  supported_languages: ['python3'],
  version_id: 'v1',
  version: 1,
  is_latest: true,
};

Deno.test({
  name: 'React 浏览器：SSR、两步登录、版本、草稿、自测、提交与移动端',
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const submissions: Record<string, unknown>[] = [];
    const selfTests: Record<string, unknown>[] = [];
    let detailReads = 0;
    let selfTestReads = 0;
    let legalAccepted = false;
    const upstream = Deno.serve({ hostname: '127.0.0.1', port: 8071, onListen() {} }, async (request) => {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === '/api/v1/auth/login') {
        const body = await request.json();
        if (!body.code) return Response.json({ error: '请输入两步验证码', code: 'TFA_REQUIRED' }, { status: 401 });
        if (body.code !== '123456') return Response.json({ error: '验证码无效' }, { status: 401 });
        return Response.json({ data: { token, user } });
      }
      if (path === '/api/v1/auth/me') {
        return request.headers.get('authorization') === `Bearer ${token}`
          ? Response.json({
            data: {
              ...user,
              legal: {
                terms: {
                  required_version: 2,
                  agreed_version: legalAccepted ? 2 : 1,
                  needs_consent: !legalAccepted,
                  is_material: true,
                },
              },
            },
          })
          : Response.json({ error: '未登录' }, { status: 401 });
      }
      if (path === '/api/v1/legal/consent') {
        const body = await request.json();
        if (body.kind === 'terms') legalAccepted = true;
        return Response.json({ data: { kind: body.kind } });
      }
      if (path === '/api/v1/auth/oauth/providers') return Response.json({ data: [] });
      if (path === '/api/v1/problems') {
        return Response.json({
          data: [problem],
          total: 1,
          page: 1,
          limit: Number(url.searchParams.get('limit') ?? 20),
        });
      }
      if (path === '/api/v1/problems/P404') return Response.json({ error: '题目不存在' }, { status: 404 });
      if (path === '/api/v1/problems/P2') {
        return Response.json({
          data: {
            ...problem,
            id: 'fixture-file',
            display_id: 'P2',
            title: '预测提交',
            submission_mode: 'prediction',
            artifact_max_size_mb: 1,
          },
        });
      }
      if (path === '/api/v1/problems/P1' || path === '/api/v1/problems/fixture-problem') {
        return Response.json({
          data: url.searchParams.get('version_id') === 'v2' ? { ...problem, version_id: 'v2', version: 2 } : problem,
        });
      }
      if (path.endsWith('/versions')) {
        return Response.json({
          data: [{ id: 'v2', version: 2, is_latest: true }, { id: 'v1', version: 1, is_latest: false }],
        });
      }
      if (path.endsWith('/template')) return Response.json({ data: { content: 'print(1)', language: 'python3' } });
      if (path === '/api/v1/submissions' && request.method === 'POST') {
        if (request.headers.get('content-type')?.includes('multipart/form-data')) {
          const form = await request.formData();
          submissions.push({
            problem_id: form.get('problem_id'),
            version_id: form.get('version_id'),
            file_name: (form.get('file') as File).name,
          });
        } else submissions.push(await request.json());
        return Response.json({ data: { id: 's1', public_id: 'sb-fixture' } });
      }
      if (path === '/api/v1/problems/fixture-problem/self-test') {
        selfTests.push(await request.json());
        return Response.json({ data: { id: 't1' } });
      }
      if (path === '/api/v1/self-tests/t1') {
        selfTestReads++;
        return Response.json({ data: { id: 't1', status: 'finished', output: 'fixture output' } });
      }
      if (path === '/api/v1/submissions/sb-fixture') {
        detailReads++;
        if (detailReads % 2 === 0) await new Promise((resolve) => setTimeout(resolve, 2600));
        return Response.json({
          data: {
            id: 's1',
            public_id: 'sb-fixture',
            user_id: user.id,
            problem_id: problem.id,
            problem: { id: problem.id, display_id: 'P1', title: problem.title },
            language: 'python3',
            code: 'print(42)',
            status: detailReads % 2 ? 'pending' : 'finished',
            created_at: '2026-10-24T00:00:00Z',
            submitted_version: 1,
            submitted_version_id: 'v1',
            version_origin: 'known',
            result: detailReads % 2 ? null : {
              status: 'Accepted',
              score: 1234,
              time_ms: 15,
              memory_kb: 1024,
              details: {
                cases: [{
                  case_id: 'hidden',
                  status: 'Accepted',
                  visibility: 'hidden',
                  input: 'hidden-secret',
                  expected_output: 'hidden-secret',
                  actual_output: 'hidden-secret',
                }],
              },
            },
          },
        });
      }
      if (path.endsWith('/events')) {
        return new Response('event: submission:updated\ndata: {}\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (path.includes('/submissions')) return Response.json({ data: [], pagination: { total: 0, total_pages: 0 } });
      if (path === '/api/v1/community/config') {
        return Response.json({ data: { enabled: false, follows_enabled: false, moments_enabled: false } });
      }
      if (path === '/api/v1/checkin/today') return Response.json({ data: { checked_in: true, streak: 1 } });
      if (path.endsWith('/ban-status')) {
        return Response.json({ ip_banned: false, user_banned: false, authenticated: false });
      }
      return Response.json({ data: [] });
    });
    const browser = await chromium.launch({ headless: true }).catch(async (error) => {
      await upstream.shutdown();
      throw error;
    });
    let currentPage: Page | undefined;
    try {
      for (const width of [1440, 390]) {
        legalAccepted = false;
        const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
        const page = await context.newPage();
        currentPage = page;
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (event) => {
          if (event.type() === 'error' && /hydration|hydrating|React child|key.*spread/i.test(event.text())) {
            errors.push(event.text());
          }
        });
        const ssr = await page.request.get(`${uiUrl}/react/problems/P1`);
        expect(ssr.status()).toBe(200);
        expect(await ssr.text()).toContain('线性回归');
        const missing = await page.request.get(`${uiUrl}/react/problems/P404`);
        expect(missing.status()).toBe(404);

        await page.goto(`${uiUrl}/react/editor/P1?version_id=v1`);
        await expect(page).toHaveURL(/\/react\/login\?redirect=/);
        await page.getByLabel('用户名或邮箱', { exact: true }).fill('fixture');
        await page.getByLabel('密码', { exact: true }).fill('fixture-password');
        await page.getByLabel('记住我', { exact: true }).check();
        await page.locator('form').getByRole('button', { name: '登录', exact: true }).click();
        await page.getByLabel('动态码或恢复码', { exact: true }).fill('123456');
        const [loginResponse] = await Promise.all([
          page.waitForResponse((response) => response.url().endsWith('/api/v1/auth/login')),
          page.getByRole('button', { name: '验证并登录', exact: true }).click(),
        ]);
        expect(loginResponse.status()).toBe(200);
        expect(JSON.stringify(await loginResponse.json())).not.toContain(token);
        await expect(page).toHaveURL(/\/react\/editor\/P1\?version_id=v1/);
        const cookies = await context.cookies();
        const tokenCookie = cookies.find((cookie) => cookie.name === 'noj:token');
        expect(tokenCookie?.httpOnly).toBe(true);
        expect((tokenCookie?.expires ?? 0) - Date.now() / 1000).toBeGreaterThan(20 * 86400);
        const consent = page.getByRole('dialog', { name: '政策更新通知', exact: true });
        await expect(consent).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(consent).toBeVisible();
        await consent.getByRole('button', { name: '我已知悉并同意', exact: true }).click();
        await expect(consent).toBeHidden();

        const editor = page.getByRole('textbox', { name: '代码', exact: true });
        await expect(editor).toBeVisible({ timeout: 30_000 });
        await editor.press('ControlOrMeta+A');
        await page.keyboard.insertText('print(42)');
        await page.getByRole('button', { name: '提交评测', exact: true }).click();
        await expect(page.getByText('提交已进入评测队列')).toBeVisible();
        expect(submissions.at(-1)?.version_id).toBe('v1');
        expect(submissions.at(-1)?.code).toBe('print(42)');
        expect(
          await page.evaluate(() => localStorage.getItem('noj:react:draft:fixture-user:fixture-problem:v1:python3')),
        ).toBe('print(42)');

        await page.getByRole('button', { name: '运行自测', exact: true }).click();
        await expect(page.getByText('fixture output', { exact: true })).toBeVisible();
        expect(selfTests.at(-1)?.version_id).toBe('v1');
        const terminalReads = selfTestReads;
        await new Promise((resolve) => setTimeout(resolve, 1800));
        expect(selfTestReads).toBe(terminalReads);

        await page.getByRole('link', { name: '查看本次评测结果', exact: true }).click();
        await expect(page.getByText('12.3 分', { exact: false })).toBeVisible({ timeout: 10_000 });
        expect(await page.getByText('hidden-secret').count()).toBe(0);
        const finishedReads = detailReads;
        await new Promise((resolve) => setTimeout(resolve, 2200));
        expect(detailReads).toBe(finishedReads);
        await page.goBack();
        await expect(page.getByRole('button', { name: '提交评测', exact: true })).toBeEnabled();

        await page.goto(`${uiUrl}/react/problems?keyword=${encodeURIComponent('线性')}`);
        await expect(page.getByRole('link', { name: '线性回归', exact: true })).toBeVisible();
        await page.getByRole('link', { name: '线性回归', exact: true }).click();
        await page.getByRole('combobox', { name: '作答版本', exact: true }).click();
        await page.getByRole('option', { name: 'v2 · 最新', exact: true }).click();
        await expect(page).toHaveURL(/version_id=v2/);
        await expect(page.getByText('v2', { exact: true })).toBeVisible();
        await page.goBack();
        await expect(page).not.toHaveURL(/version_id=v2/);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
          .toBe(true);
        if (screenshotDir) {
          await Deno.mkdir(screenshotDir, { recursive: true });
          await page.screenshot({ path: `${screenshotDir}/problem-${width}.png`, fullPage: true });
        }
        const uploadDir = await Deno.makeTempDir({ prefix: 'noj-react-upload-' });
        try {
          const uploadFile = `${uploadDir}/prediction.csv`;
          await Deno.writeTextFile(uploadFile, 'id,prediction\n1,0.5\n');
          await page.goto(`${uiUrl}/react/problems/P2`);
          await page.locator('input[type=file]').setInputFiles(uploadFile);
          await page.getByRole('button', { name: '提交评测', exact: true }).click();
          await expect(page.getByText('提交成功', { exact: true })).toBeVisible();
          expect(submissions.at(-1)).toEqual({
            problem_id: 'fixture-file',
            version_id: 'v1',
            file_name: 'prediction.csv',
          });
        } finally {
          await Deno.remove(uploadDir, { recursive: true });
        }
        expect(errors).toEqual([]);
        await context.close();
      }
    } catch (error) {
      if (currentPage && !currentPage.isClosed()) {
        const failureDir = screenshotDir ?? await Deno.makeTempDir({ prefix: 'noj-react-failure-' });
        await Deno.mkdir(failureDir, { recursive: true });
        await currentPage.screenshot({ path: `${failureDir}/failure.png`, fullPage: true });
        console.error((await currentPage.locator('body').innerText()).slice(0, 4000));
      }
      throw error;
    } finally {
      await browser.close();
      await upstream.shutdown();
    }
  },
});
