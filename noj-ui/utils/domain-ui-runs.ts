import type { UiFrameResult } from './uiFrame.ts';
import { getStatusLabel } from './submissionFormat.ts';

/** 界面只接收域接口已公开的汇总；hidden 不读取嵌套结果或评测输出。 */
export function domainUiSubmissionResult(record: {
  result_visibility?: 'hidden' | 'summary' | 'cases';
  status?: string;
  result?: { status: string; score?: number } | null;
}): UiFrameResult {
  if (record.result_visibility === 'hidden') {
    return { kind: 'submit', status: 'accepted', label: '已受理', score: null };
  }
  const status = record.status ?? 'pending';
  return {
    kind: 'submit',
    status,
    label: getStatusLabel(status, record.result?.status),
    score: status === 'finished' && record.result?.score != null ? record.result.score / 100 : null,
  };
}
/** 自测状态与结果由现有受裁剪 Domain DTO 提供，不重新获取 evaluator 详情。 */
export function domainUiSelfTestResult(record: {
  status: string;
  result_status: string | null;
  score: number;
  resource_available: boolean;
  output?: string | null;
}): UiFrameResult {
  return {
    kind: 'self-test',
    status: record.status,
    label: getStatusLabel(record.status, record.result_status ?? undefined),
    score: record.status === 'finished' ? record.score / 100 : null,
    ...(record.resource_available && record.output ? { output: record.output } : {}),
  };
}
