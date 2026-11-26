/** 可切换的界面风格；token 定义见 assets/css/main.css 的 html[data-style] 段。 */
export const UI_STYLES = [
  { value: 'terminal', label: '深色终端' },
  { value: 'modern', label: '精致现代' },
  { value: 'bold', label: '鲜明个性' },
  { value: 'editorial', label: '学术杂志' },
  { value: 'tech', label: '科技风' },
] as const;

export type UiStyle = (typeof UI_STYLES)[number]['value'];

export const UI_STYLE_COOKIE = 'noj-style';

/** 默认风格：深色终端（无 cookie 或值非法时使用）。 */
export const DEFAULT_UI_STYLE: UiStyle = 'terminal';

/** 只接受已知风格，cookie 被篡改或过期值一律回退默认。 */
export function normalizeUiStyle(value: unknown): UiStyle {
  return UI_STYLES.some((style) => style.value === value) ? value as UiStyle : DEFAULT_UI_STYLE;
}
