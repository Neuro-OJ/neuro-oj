/// <reference lib="deno.ns" />
// deno-lint-ignore no-import-prefix -- jsr: 前缀由 deno.lock 固定版本
import { assert, assertEquals } from 'jsr:@std/assert@^1';
import { resolveBreadcrumb } from '../utils/breadcrumb.ts';

/**
 * 漂移门禁（#512 Phase 4）。
 *
 * 全站 61 个页面里，没有门禁的注册表必然漂移：新增内容页会「默认没有面包屑」，
 * 而这正是本 issue 要解决的问题。因此这里遍历 `pages/` 目录把文件路径还原为
 * 路由模式，断言每个「内容页」都能解析出非空层级。
 *
 * 白名单之外的页面一旦新增且未注册，本测试即失败——与
 * `scripts/check-file-size.ts`、`gen-route-catalog --check` 同属
 * 「静态断言防漂移」的既有做法。
 */

const PAGES_DIR = new URL('../pages/', import.meta.url);

/** 不参与面包屑的页面（与 issue 范围一致）：管理后台 + 认证页 + 独立布局页。 */
const EXCLUDED_PREFIXES = [
  'admin/',
  'login',
  'register',
  'forgot-password',
  'reset-password',
  'set-password',
  'change-password',
  'verify-email',
];

/** 首页：无层级语义。 */
const EXCLUDED_EXACT = ['index.vue'];

/** 独立全屏布局（`layout: false`），不经过 default 布局，无面包屑。 */
const LAYOUTLESS = ['editor/[id].vue'];

async function collectPageRoutes(dir: URL, prefix = ''): Promise<string[]> {
  const routes: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory) {
      routes.push(...(await collectPageRoutes(new URL(`${entry.name}/`, dir), `${relative}/`)));
      continue;
    }
    if (!entry.name.endsWith('.vue')) continue;
    routes.push(relative);
  }
  return routes;
}

/** `problems/[id]/edit.vue` → `/problems/:id/edit`；`problems.vue` → `/problems`。 */
function fileToPattern(file: string): string {
  const withoutExt = file.replace(/\.vue$/, '');
  const segments = withoutExt
    .split('/')
    .filter((segment) => segment !== 'index');
  const mapped = segments.map((segment) =>
    segment.startsWith('[') && segment.endsWith(']') ? `:${segment.slice(1, -1)}` : segment
  );
  return `/${mapped.join('/')}`;
}

function isExcluded(file: string): boolean {
  if (EXCLUDED_EXACT.includes(file)) return true;
  if (LAYOUTLESS.includes(file)) return true;
  return EXCLUDED_PREFIXES.some((prefix) => file === prefix || file.startsWith(prefix));
}

Deno.test('breadcrumb 门禁：每个内容页都能解析出非空层级', async () => {
  const files = await collectPageRoutes(PAGES_DIR);
  assert(files.length > 40, `页面扫描结果异常（${files.length}）：门禁可能失效`);

  const missing: string[] = [];
  for (const file of files) {
    if (isExcluded(file)) continue;
    const pattern = fileToPattern(file);
    // 动态段用占位值填充，模拟真实访问
    const path = pattern.replace(/:([A-Za-z0-9_]+)/g, 'sample');
    if (resolveBreadcrumb(path).length === 0) missing.push(`${file} -> ${pattern}`);
  }

  assertEquals(missing, [], `以下内容页缺少面包屑层级映射（请在 utils/breadcrumb.ts 注册）：\n${missing.join('\n')}`);
});

Deno.test('breadcrumb 门禁：白名单页面确实不渲染面包屑（避免误注册）', () => {
  for (const path of ['/admin/problems', '/login', '/register', '/change-password', '/']) {
    assertEquals(resolveBreadcrumb(path), [], `${path} 不应有面包屑`);
  }
});

Deno.test('breadcrumb 门禁：注册表中的层级不会产生空链接（末层除外）', () => {
  const samplePaths = [
    '/problems/1001',
    '/problems/1001/edit',
    '/contests/c1',
    '/contests/c1/problems/A',
    '/contests/c1/ranking',
    '/submissions/s1',
    '/community/posts/p1',
    '/community/notifications',
    '/community/notifications/n1',
    '/community/reports/r1',
    '/trainings/t1',
    '/trainings/mine',
    '/announcements/a1',
    '/users/alice',
  ];
  for (const path of samplePaths) {
    const items = resolveBreadcrumb(path);
    assert(items.length > 0, `${path} 应能解析出层级`);
    for (const item of items.slice(0, -1)) {
      assert(item.to, `${path} 的「${item.label}」层缺少可点击目标`);
    }
    assertEquals(items[items.length - 1]?.to, undefined, `${path} 的末层不应可点击`);
  }
});
