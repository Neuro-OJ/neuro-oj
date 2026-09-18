/**
 * 全站面包屑的**路由 → 层级**集中注册表（#512）。
 *
 * 为什么是纯函数放在 `utils/`：
 * - `definePageMeta` 是编译期宏、值必须可序列化，无法在页面里放函数解析动态标题，
 *   因此层级必须由「集中声明的路由表」推导，而不是每页手写；
 * - 纯逻辑放 utils 可被 `deno task test` 直接断言（本仓库既有约定，
 *   同 `utils/problemStats.ts`、`utils/problemView.ts`）；
 * - 解析本身是 `route.path` 与 `locale` 的纯函数，**不需要中间件**，
 *   布局组件在 SSR 首帧即可算出（见 `composables/useBreadcrumb.ts` 的说明）。
 *
 * 覆盖范围：`layouts/default.vue` 下的内容页。**不含** `/admin/*`
 * （后台已有“分组 + 当前项”侧栏语义，再叠面包屑冗余）与认证页
 * （`layouts/auth.vue`，单点流程无层级语义）——未注册路径解析结果为空数组，
 * 组件据此不渲染。
 */
import { DEFAULT_LOCALE, type Locale, messages } from './i18n.ts';
import { problemUrl, publicUrl, userUrl } from './publicIdentifiers.ts';

/** 解析后的单层面包屑。`to` 缺省表示当前页（末层，不可点击）。 */
export interface BreadcrumbItem {
  label: string;
  to?: string;
  /**
   * 该层对应的动态路由参数名（静态层为 undefined）。
   *
   * 页面的 async 数据晚于布局渲染到达，无法在首帧就知道题目/竞赛标题，
   * 因此由页面通过 `useBreadcrumbParams` 按参数名回填人类可读文案。
   */
  param?: string;
}

/** 注册表条目：路由模式 + 层级模板。 */
interface BreadcrumbRoute {
  /** 形如 `/contests/:contestId/problems/:label`。 */
  pattern: string;
  /**
   * 层级模板。字符串为 i18n 键或动态参数占位；
   * `{ param }` 在解析时替换为路由参数值（人类可读文案由页面后续精化）。
   */
  trail: TrailEntry[];
}

/** 层级模板项。 */
type TrailEntry =
  /** i18n 键；`to` 缺省时表示该层为目标页（末层）。 */
  | { key: string; to?: string }
  /** 动态段：文案取路由参数，链接由固定前缀推导。 */
  | { param: string };

/**
 * 静态 → 动态优先级由本表顺序保证：解析时先精确匹配静态模式。
 *
 * 路径一律复用 `utils/publicIdentifiers.ts` 的构造规则，
 * 不在此重复拼字符串。
 */
const ROUTES: BreadcrumbRoute[] = [
  // ── 题库 ──
  { pattern: '/problems', trail: [{ key: 'nav.problems' }] },
  { pattern: '/problems/new', trail: [{ key: 'nav.problems', to: '/problems' }, { key: 'breadcrumb.newProblem' }] },
  {
    pattern: '/problems/new/coding',
    trail: [{ key: 'nav.problems', to: '/problems' }, { key: 'breadcrumb.newProblem', to: '/problems/new' }, {
      key: 'breadcrumb.newCodingProblem',
    }],
  },
  {
    pattern: '/problems/new/objective',
    trail: [{ key: 'nav.problems', to: '/problems' }, { key: 'breadcrumb.newProblem', to: '/problems/new' }, {
      key: 'breadcrumb.newObjectiveProblem',
    }],
  },
  { pattern: '/problems/:id', trail: [{ key: 'nav.problems', to: '/problems' }, { param: 'id' }] },
  {
    pattern: '/problems/:id/edit',
    trail: [{ key: 'nav.problems', to: '/problems' }, { param: 'id' }, { key: 'breadcrumb.edit' }],
  },
  { pattern: '/my/problems', trail: [{ key: 'breadcrumb.myProblems' }] },

  // ── 竞赛 ──
  { pattern: '/contests', trail: [{ key: 'nav.contests' }] },
  { pattern: '/contests/:contestId', trail: [{ key: 'nav.contests', to: '/contests' }, { param: 'contestId' }] },
  {
    pattern: '/contests/:contestId/problems/:label',
    trail: [{ key: 'nav.contests', to: '/contests' }, { param: 'contestId' }, { param: 'label' }],
  },
  {
    pattern: '/contests/:contestId/ranking',
    trail: [{ key: 'nav.contests', to: '/contests' }, { param: 'contestId' }, { key: 'breadcrumb.ranking' }],
  },

  // ── 提交记录 ──
  { pattern: '/submissions', trail: [{ key: 'nav.submissions' }] },
  { pattern: '/submissions/:id', trail: [{ key: 'nav.submissions', to: '/submissions' }, { param: 'id' }] },

  // ── 题单 ──
  { pattern: '/trainings', trail: [{ key: 'nav.trainings' }] },
  {
    pattern: '/trainings/mine',
    trail: [{ key: 'nav.trainings', to: '/trainings' }, { key: 'breadcrumb.myTrainings' }],
  },
  { pattern: '/trainings/:id', trail: [{ key: 'nav.trainings', to: '/trainings' }, { param: 'id' }] },

  // ── 社区 ──
  { pattern: '/community', trail: [{ key: 'nav.community' }] },
  {
    pattern: '/community/posts/:postId',
    trail: [{ key: 'nav.community', to: '/community' }, { param: 'postId' }],
  },
  {
    pattern: '/community/bookmarks',
    trail: [{ key: 'nav.community', to: '/community' }, { key: 'breadcrumb.myBookmarks' }],
  },
  {
    pattern: '/community/notifications',
    trail: [{ key: 'nav.community', to: '/community' }, { key: 'breadcrumb.notifications' }],
  },
  {
    pattern: '/community/notifications/:id',
    trail: [{ key: 'nav.community', to: '/community' }, {
      key: 'breadcrumb.notifications',
      to: '/community/notifications',
    }, { param: 'id' }],
  },
  {
    pattern: '/community/reports/:id',
    trail: [{ key: 'nav.community', to: '/community' }, {
      key: 'breadcrumb.notifications',
      to: '/community/notifications',
    }, { key: 'breadcrumb.reportDetail' }],
  },

  // ── 公告 ──
  { pattern: '/announcements', trail: [{ key: 'nav.announcements' }] },
  { pattern: '/announcements/:id', trail: [{ key: 'nav.announcements', to: '/announcements' }, { param: 'id' }] },

  // ── 用户与私信 ──
  { pattern: '/users/:id', trail: [{ param: 'id' }] },
  { pattern: '/messages', trail: [{ key: 'breadcrumb.messages' }] },

  // ── 榜单与队列 ──
  { pattern: '/ranking', trail: [{ key: 'nav.ranking' }] },
  { pattern: '/queue', trail: [{ key: 'nav.queue' }] },

  // ── 单层工具页（深度 1，只有当前层）──
  { pattern: '/search', trail: [{ key: 'nav.search' }] },
  { pattern: '/settings', trail: [{ key: 'breadcrumb.settings' }] },
  { pattern: '/about', trail: [{ key: 'breadcrumb.about' }] },
  { pattern: '/data-policy', trail: [{ key: 'breadcrumb.dataPolicy' }] },
];

/** 把 `/a/:b/c` 编译为「静态段数组」，便于无正则匹配。 */
function compile(pattern: string): Array<{ literal: string } | { param: string }> {
  return pattern
    .split('/')
    .filter(Boolean)
    .map((segment) => (segment.startsWith(':') ? { param: segment.slice(1) } : { literal: segment }));
}

interface CompiledRoute {
  pattern: string;
  segments: Array<{ literal: string } | { param: string }>;
  /** 静态段数量，用于「静态优先」排序。 */
  literalCount: number;
  trail: TrailEntry[];
}

const COMPILED: CompiledRoute[] = ROUTES.map((route) => ({
  pattern: route.pattern,
  segments: compile(route.pattern),
  literalCount: compile(route.pattern).filter((s) => 'literal' in s).length,
  trail: route.trail,
}));

/** 把路径归一为无查询串、无尾斜杠的分段数组。 */
function splitPath(path: string): string[] {
  const withoutQuery = path.split('?')[0] ?? '';
  const clean = withoutQuery.split('#')[0] ?? '';
  return clean.split('/').filter(Boolean);
}

/** 匹配结果：路由模式与提取到的动态参数。 */
export interface BreadcrumbMatch {
  pattern: string;
  params: Record<string, string>;
}

/**
 * 按路径匹配注册表。
 *
 * 静态段更多的模式优先，保证 `/trainings/mine` 不会落到 `/trainings/:id`。
 */
export function matchBreadcrumbRoute(path: string): BreadcrumbMatch | null {
  const parts = splitPath(path);
  if (parts.length === 0) return null;

  const candidates = COMPILED
    .filter((route) => route.segments.length === parts.length)
    .sort((a, b) => b.literalCount - a.literalCount);

  for (const route of candidates) {
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < route.segments.length; i++) {
      const segment = route.segments[i];
      const part = parts[i];
      if (!segment || part === undefined) {
        ok = false;
        break;
      }
      if ('literal' in segment) {
        if (segment.literal !== part) {
          ok = false;
          break;
        }
      } else {
        params[segment.param] = part;
      }
    }
    if (ok) return { pattern: route.pattern, params };
  }
  return null;
}

/** 动态层的可点击目标：按模式前缀 + 已解析参数还原（复用 publicIdentifiers 规则）。 */
function dynamicTarget(pattern: string, paramName: string, params: Record<string, string>): string | undefined {
  // 只有出现在列表页语境下的动态段才有稳定回跳目标；其余（如帖子、题单）
  // 指向各自列表页，避免构造出无法解析的 URL。
  const prefix = pattern.split('/').slice(0, pattern.split('/').indexOf(`:${paramName}`)).join('/');
  const value = params[paramName];
  if (!value) return undefined;

  // 题目 / 用户 / 竞赛 / 提交 / 题单 / 帖子 / 公告均有公开标识构造器
  if (prefix === '/problems') return problemUrl(value);
  if (prefix === '/users') return userUrl(value);
  if (prefix === '/contests') return publicUrl('contest', value);
  if (prefix === '/submissions') return publicUrl('submission', value);
  if (prefix === '/trainings') return publicUrl('training', value);
  if (prefix === '/announcements') return publicUrl('announcement', value);
  if (prefix === '/community/posts') return publicUrl('post', value);
  return undefined;
}

/** 取 i18n 文案（复用既有 `messages` 表，避免重复维护词条）。 */
function label(key: string, locale: Locale): string {
  return messages[locale][key] ?? messages[DEFAULT_LOCALE][key] ?? key;
}

/**
 * 解析路径为面包屑层级。
 *
 * - 未注册路径（`/admin/*`、认证页等）返回空数组，调用方据此不渲染；
 * - 非末层保证有 `to`；末层无 `to`（当前页）；
 * - 动态段先以路由参数占位（如 `1001`），页面拿到数据后可用
 *   `useBreadcrumbLabel` 精化为标题。
 */
export function resolveBreadcrumb(path: string, locale: Locale = DEFAULT_LOCALE): BreadcrumbItem[] {
  const match = matchBreadcrumbRoute(path);
  if (!match) return [];

  const route = COMPILED.find((r) => r.pattern === match.pattern);
  if (!route) return [];

  const items: BreadcrumbItem[] = [];
  for (const entry of route.trail) {
    if ('key' in entry) {
      items.push({ label: label(entry.key, locale), to: entry.to });
    } else {
      const value = match.params[entry.param];
      if (value === undefined) continue;
      items.push({
        label: value,
        to: dynamicTarget(match.pattern, entry.param, match.params),
        param: entry.param,
      });
    }
  }

  // 末层强制不可点击：即便模板里配了 to 也忽略，保证 aria-current="page" 语义
  const last = items[items.length - 1];
  if (last) delete last.to;
  return items;
}
