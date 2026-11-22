import ReportModal from '~/components/feature/community/ReportModal.vue';
import { useOverlay } from '@nuxt/ui/composables';
import type { ReportCategory } from '~/utils/reportCategories';

export interface ReportResult {
  category: ReportCategory;
  reason: string;
}

/**
 * 举报弹窗命令式 API：调用 open() 返回 Promise<ReportResult | null>。
 * - 返回 ReportResult：用户选择了分类（必选）+ 可选理由
 * - 返回 null：用户取消
 */
export function useReportModal() {
  const overlay = useOverlay();

  async function open(): Promise<ReportResult | null> {
    if (import.meta.server) return null;
    const instance = overlay.create(ReportModal);
    const res = await instance.open();
    return res;
  }

  return { open };
}
