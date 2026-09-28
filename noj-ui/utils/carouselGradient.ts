/**
 * 轮播渐变预设（与后端 `gradient_key` 白名单一致）。
 *
 * `kind=text` 的幻灯片用渐变背景；`kind=image` 渲染图片。
 * 未知 key 回退到第一项，避免空 class。
 */

/** 渐变预设键 → Tailwind 渐变类。 */
export const CAROUSEL_GRADIENTS: Record<string, string> = {
  blue: 'from-[#e0f2fe] via-[#f0f9ff] to-[#ffffff]',
  green: 'from-[#d1fae5] via-[#ecfdf5] to-[#ffffff]',
  purple: 'from-[#ede9fe] via-[#f5f3ff] to-[#ffffff]',
  sunset: 'from-[#ffedd5] via-[#fff7ed] to-[#ffffff]',
  ocean: 'from-[#cffafe] via-[#f0fdfa] to-[#ffffff]',
  slate: 'from-[#e2e8f0] via-[#f8fafc] to-[#ffffff]',
};

/** 默认渐变（无 slide / 未知 key 时）。 */
export const DEFAULT_GRADIENT = 'from-[#e0f2fe] via-[#f0f9ff] to-[#ffffff]';

/**
 * 取渐变类：优先用 `gradient_key`，未知 key 回退默认。
 *
 * @param key 渐变预设键（可空）
 */
export function gradientClass(key: string | null | undefined): string {
  if (!key) return DEFAULT_GRADIENT;
  return CAROUSEL_GRADIENTS[key] ?? DEFAULT_GRADIENT;
}
