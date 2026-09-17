import type { BreadcrumbItem } from '~/utils/breadcrumb';
import { resolveBreadcrumb } from '~/utils/breadcrumb';

/**
 * 面包屑状态（#512）。
 *
 * 与 issue 初稿的差异：**不引入全局中间件**。
 * 中间件的论证是「布局渲染早于页面 setup，靠页面写 state 会让 SSR 首帧为空」——
 * 该论证针对的是「页面在 setup 里写整条层级」，而层级本身是 `route.path` 与
 * `locale` 的纯函数，布局组件在 SSR 首帧就能直接算出，无需任何 state 或中间件。
 * 少一个中间件即少一处 SSR/客户端双跑的分歧点。
 *
 * 唯一需要页面参与的是**动态层的人类可读文案**：async 数据必然晚于布局渲染，
 * 因此由页面用 `useBreadcrumbParams` 回填（首帧先显示路由参数占位，不闪空白）。
 */

/** 覆盖值按「路径 + 参数名」分键，避免不同路由之间串味。 */
function overrideKey(path: string, param: string): string {
  return `${path}::${param}`;
}

/** 当前路径的面包屑层级（响应 locale 切换，无需重新导航）。 */
export function useBreadcrumbItems() {
  const route = useRoute();
  const { locale } = useI18n();
  const overrides = useState<Record<string, string>>('breadcrumb:overrides', () => ({}));

  return computed<BreadcrumbItem[]>(() => {
    const items = resolveBreadcrumb(route.path, locale.value);
    if (items.length === 0) return items;
    return items.map((item): BreadcrumbItem => {
      if (!item.param) return item;
      const override = overrides.value[overrideKey(route.path, item.param)];
      return override ? { ...item, label: override } : item;
    });
  });
}

/**
 * 用页面数据精化动态层文案。
 *
 * `getters` 的键为路由参数名（如 `id`、`contestId`、`label`），
 * 返回值为该层的展示文案；返回空值时保留路由参数占位。
 *
 * 例：`useBreadcrumbParams({ id: () => problem.value?.title })`
 */
export function useBreadcrumbParams(
  getters: Record<string, () => string | null | undefined>,
) {
  const route = useRoute();
  const overrides = useState<Record<string, string>>('breadcrumb:overrides', () => ({}));

  // 路由切换后旧路径的覆盖值不再需要，绑定到当前页面的生命周期内清理
  const path = route.path;
  const keys = Object.keys(getters).map((param) => overrideKey(path, param));

  watchEffect(() => {
    for (const [param, getter] of Object.entries(getters)) {
      const value = getter()?.trim();
      if (!value) continue;
      const key = overrideKey(path, param);
      if (overrides.value[key] === value) continue;
      overrides.value = { ...overrides.value, [key]: value };
    }
  });

  onScopeDispose(() => {
    const next = { ...overrides.value };
    for (const key of keys) delete next[key];
    overrides.value = next;
  });
}

/** 单动态层页面的便捷写法（等价于 `useBreadcrumbParams({ [param]: getter })`）。 */
export function useBreadcrumbLabel(
  getter: () => string | null | undefined,
  param = 'id',
) {
  useBreadcrumbParams({ [param]: getter });
}
