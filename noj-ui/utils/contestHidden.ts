/**
 * 「被公开赛收编」题目的视觉标识契约（VULN-07）。
 *
 * 后端只对**特权用户**（管理员 / 题目所有者）在列表中下发
 * `is_contest_hidden: true`；普通用户根本看不到该行（SQL 层过滤）。
 * 因此这些标识只解决「特权用户误以为自己看到的题目对所有人可见」的认知问题，
 * 不承担任何访问控制职责。
 *
 * 放在 `utils/` 而非组件内：本仓库约定**纯逻辑与契约放 utils**
 * （可被 `deno task test` 直接断言），样式类名与提示文案由此成为单一事实来源，
 * 避免同一条斜纹魔法字符串在多个页面各抄一份。
 */

/** 悬浮提示文案：说明该题目对普通用户不可见。 */
export const CONTEST_HIDDEN_TIP = '该题目已被公开赛收编，当前对普通用户处于隐藏保密状态';

/**
 * 斜纹底样式类名。
 *
 * 实现在 `assets/css/main.css` 的 `@utility contest-hidden-stripes`
 * （Tailwind v4 自定义工具类，可被 `dark:` / `hover:` 等变体修饰）。
 */
export const CONTEST_HIDDEN_STRIPES_CLASS = 'contest-hidden-stripes';

/**
 * 行/卡片的条件样式类。
 *
 * @param hidden 后端下发的 `is_contest_hidden`；未下发（undefined）时按"未收编"处理。
 * @returns 需要斜纹底时返回样式类名，否则返回空串（便于直接绑定 `:class`）。
 */
export function contestHiddenRowClass(hidden?: boolean | null): string {
  return hidden === true ? CONTEST_HIDDEN_STRIPES_CLASS : '';
}
