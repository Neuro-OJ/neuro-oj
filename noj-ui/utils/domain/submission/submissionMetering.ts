/** 可公开展示的测试点工作量统计，不包含测试输入或输出。 */
export interface SubmissionMeteringCase {
  subtask: string;
  caseId: string;
  status: string;
  fuel: number | null;
  budget: number | null;
  equivalentTimeMs: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** 从 OI 子任务中提取计量表格行，缺失统计保留为空。 */
export function submissionMeteringCases(details: unknown): SubmissionMeteringCase[] {
  const oi = record(record(details)?.oi);
  if (!Array.isArray(oi?.subtasks)) return [];
  return oi.subtasks.flatMap((value) => {
    const subtask = record(value);
    if (!Array.isArray(subtask?.cases)) return [];
    return subtask.cases.flatMap((value, index) => {
      const item = record(value);
      if (!item) return [];
      return [{
        subtask: typeof subtask.id === 'string' ? subtask.id : '—',
        caseId: typeof item.case_id === 'string' ? item.case_id : `测试点 ${index + 1}`,
        status: typeof item.status === 'string' ? item.status : '—',
        fuel: number(item.fuel_consumed),
        budget: number(item.fuel_budget),
        equivalentTimeMs: number(item.equivalent_time_ms),
      }];
    });
  });
}

/** 历史标准沿用等效时间名称，v3 使用参考时间，避免追溯改写结果含义。 */
export function submissionMeteringTimeLabel(standardVersion?: unknown): string {
  return standardVersion === 'noj-wasm-v3' ? '参考时间' : '等效时间';
}
