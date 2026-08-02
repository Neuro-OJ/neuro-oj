import { useOverlay } from '@nuxt/ui/composables';
import DialogModal from '~/components/ui/DialogModal.vue';

interface DialogOptions {
  title?: string;
  danger?: boolean;
  confirmText?: string;
  cancelText?: string;
}

interface PromptOptions {
  title?: string;
  placeholder?: string;
  confirmText?: string;
}

interface DialogMethods {
  confirm(message: string, options?: DialogOptions): Promise<boolean>;
  alert(message: string, options?: { title?: string }): Promise<void>;
  prompt(message: string, options?: PromptOptions): Promise<string | null>;
}

// settings.vue 等调用点的对象式调用 `dialog({ title, text, danger, ... })`
interface DialogShorthandOptions {
  title?: string;
  text?: string;
  message?: string;
  danger?: boolean;
  confirmText?: string;
  cancelText?: string;
}

export type DialogApi = DialogMethods & ((options: DialogShorthandOptions) => Promise<boolean>);

export function useDialog(): { dialog: DialogApi } {
  const overlay = useOverlay();

  async function confirm(message: string, options: DialogOptions = {}): Promise<boolean> {
    if (import.meta.server) return false;
    const instance = overlay.create(DialogModal);
    const res = await instance.open({ mode: 'confirm', message, ...options });
    return res === true;
  }

  async function alert(message: string, options: { title?: string } = {}): Promise<void> {
    if (import.meta.server) return;
    const instance = overlay.create(DialogModal);
    await instance.open({ mode: 'alert', message, ...options });
  }

  async function prompt(message: string, options: PromptOptions = {}): Promise<string | null> {
    if (import.meta.server) return null;
    const instance = overlay.create(DialogModal);
    const res = await instance.open({ mode: 'prompt', message, ...options });
    return typeof res === 'string' ? res : null;
  }

  // 兼容对象式调用：`dialog({ title, text, danger, ... })` 等价于 dialog.confirm(text, options)
  const dialog = Object.assign(
    (options: DialogShorthandOptions): Promise<boolean> =>
      confirm(options.message ?? options.text ?? '', {
        title: options.title,
        danger: options.danger,
        confirmText: options.confirmText,
        cancelText: options.cancelText,
      }),
    { confirm, alert, prompt },
  ) as DialogApi;

  return { dialog };
}
