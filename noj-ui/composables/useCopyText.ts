import { useToast } from './useToast';

/**
 * 复制文本到剪贴板的统一封装。
 * 复制失败时给出统一错误提示，避免各页面重复实现。
 */
export function useCopyText() {
  const { toast } = useToast();

  async function copyText(text: string | null, label: string) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${label}已复制`);
    } catch {
      toast.error('复制失败，请手动复制');
    }
  }

  return { copyText };
}
