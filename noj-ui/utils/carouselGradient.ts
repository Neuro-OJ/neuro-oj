/**
 * 轮播渐变预设（与后端 `gradient_key` 白名单一致）。
 *
 * `kind=text` 的幻灯片用渐变背景；`kind=image` 渲染图片。
 * 未知 key 回退到第一项，避免空 class。
 */

/** 渐变预设键 → Tailwind 渐变类。 */
export const CAROUSEL_GRADIENTS: Record<string, string> = {
  blue: 'from-[#eef0f5] via-[#f2f2ec] to-[#e8e8e2]',
  green: 'from-[#e6fbf3] via-[#f2f2ec] to-[#e8e8e2]',
  purple: 'from-[#f0ecf7] via-[#f2f2ec] to-[#e8e8e2]',
  sunset: 'from-[#fdeee4] via-[#f2f2ec] to-[#e8e8e2]',
  ocean: 'from-[#e4f1fb] via-[#f2f2ec] to-[#e8e8e2]',
  slate: 'from-[#eef0f5] via-[#e8e8e2] to-[#dfe0d9]',
};

/** 默认渐变（无 slide / 未知 key 时）。 */
export const DEFAULT_GRADIENT = 'from-[#f2f2ec] via-[#e8e8e2] to-[#dfe0d9]';

/**
 * 取渐变类：优先用 `gradient_key`，未知 key 回退默认。
 *
 * @param key 渐变预设键（可空）
 */
export function gradientClass(key: string | null | undefined): string {
  if (!key) return DEFAULT_GRADIENT;
  return CAROUSEL_GRADIENTS[key] ?? DEFAULT_GRADIENT;
}
