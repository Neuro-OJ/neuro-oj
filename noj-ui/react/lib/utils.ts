import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn/ui 组件统一合并条件类名与 Tailwind 覆盖。 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
