import { useToast as useNuxtToast } from '@nuxt/ui/composables';

// 与现有 SweetAlert2 图标语义对齐的 lucide 图标
const ICONS = {
  success: 'i-lucide-circle-check',
  error: 'i-lucide-circle-x',
  warn: 'i-lucide-triangle-alert',
  info: 'i-lucide-info',
} as const;

interface ToastMethods {
  success(message: string): void;
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
}

/** showToast 的 type 参数与方法名一一对应，无需桥接映射。 */
type ToastType = keyof ToastMethods;

interface UseToastResult {
  toast: ToastMethods;
  showToast(type: ToastType, message: string): void;
}

export function useToast(): UseToastResult {
  const toastApi = useNuxtToast();

  // SSR 阶段不发通知（Nuxt UI 的 toast 依赖客户端渲染的 UToaster）
  const push = (toast: Parameters<typeof toastApi.add>[0]) => {
    if (import.meta.client) toastApi.add(toast);
  };

  const toast: ToastMethods = {
    success: (msg) => push({ title: msg, color: 'success', icon: ICONS.success, duration: 3000 }),
    error: (msg) => push({ title: msg, color: 'error', icon: ICONS.error, duration: 5000 }),
    warn: (msg) => push({ title: msg, color: 'warning', icon: ICONS.warn, duration: 3000 }),
    info: (msg) => push({ title: msg, color: 'info', icon: ICONS.info, duration: 2000 }),
  };

  function showToast(type: ToastType, message: string) {
    toast[type](message);
  }

  return { toast, showToast };
}
