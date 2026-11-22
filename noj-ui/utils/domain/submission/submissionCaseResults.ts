/**
 * 提交详情中的测试点结果归一化工具。
 *
 * 新结果使用 details.cases；历史结果可能使用 visible/hidden 分组和
 * id/expected/actual 字段。归一化时统一字段，并清除隐藏用例的敏感输出。
 */

export type SubmissionCaseVisibility = 'visible' | 'hidden';

export interface SubmissionCaseResult {
  caseId: string;
  displayLabel?: string;
  status: string;
  score?: number | null;
  maxScore?: number | null;
  terminationReason?: string | null;
  visibility: SubmissionCaseVisibility;
  timeMs: number | null;
  memoryKb: number | null;
  input: string | null;
  expectedOutput: string | null;
  actualOutput: string | null;
}

export interface SubmissionCaseProgress {
  phase: string;
  active_cases: { case_id: string; subtask_id: string }[];
  completed_cases: Record<string, unknown>[];
  total_cases: number;
}

/** 实时结果沿用明细表；未启动用例仅显示数量占位，不推测隐藏测试点标识。 */
export function submissionCasesWithProgress(
  details: unknown,
  progress?: SubmissionCaseProgress | null,
): SubmissionCaseResult[] {
  if (!progress) return normalizeSubmissionCases(details);
  const completed = normalizeArray(progress.completed_cases, 'hidden');
  const rows = new Map(completed.map((item) => [item.caseId, item]));
  for (const item of progress.active_cases) {
    if (rows.has(item.case_id)) continue;
    rows.set(item.case_id, {
      caseId: item.case_id,
      status: 'RUNNING',
      visibility: 'hidden',
      timeMs: null,
      memoryKb: null,
      input: null,
      expectedOutput: null,
      actualOutput: null,
    });
  }
  const result = [...rows.values()];
  const pending = Math.max(0, progress.total_cases - result.length);
  for (let index = 0; index < pending; index++) {
    result.push({
      caseId: `__noj_waiting_${index}`,
      displayLabel: `待开始测试点 ${index + 1}`,
      status: 'PENDING',
      visibility: 'hidden',
      timeMs: null,
      memoryKb: null,
      input: null,
      expectedOutput: null,
      actualOutput: null,
    });
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function asNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function resolveStatus(raw: Record<string, unknown>): string | null {
  const status = asString(raw.status);
  if (status) return status;
  if (typeof raw.content_ok === 'boolean') {
    return raw.content_ok ? 'Accepted' : 'WrongAnswer';
  }
  return null;
}

function resolveVisibility(
  raw: Record<string, unknown>,
  fallback: SubmissionCaseVisibility = 'visible',
): SubmissionCaseVisibility {
  return raw.visibility === 'hidden' || raw.visibility === 'visible' ? raw.visibility : fallback;
}

function normalizeCase(
  value: unknown,
  fallbackVisibility?: SubmissionCaseVisibility,
): SubmissionCaseResult | null {
  const raw = asRecord(value);
  if (!raw) return null;

  const caseId = asString(raw.case_id) ?? asString(raw.id);
  const status = resolveStatus(raw);
  if (!caseId || !status) return null;

  const visibility = resolveVisibility(raw, fallbackVisibility);
  const isHidden = visibility === 'hidden';
  return {
    caseId,
    status,
    ...(raw.score !== undefined ? { score: asNonNegativeNumber(raw.score) } : {}),
    ...(raw.max_score !== undefined ? { maxScore: asNonNegativeNumber(raw.max_score) } : {}),
    ...(raw.termination_reason !== undefined ? { terminationReason: asString(raw.termination_reason) } : {}),
    visibility,
    timeMs: asNonNegativeNumber(raw.time_ms),
    memoryKb: asNonNegativeNumber(raw.memory_kb),
    input: isHidden ? null : asString(raw.input),
    expectedOutput: isHidden ? null : asString(raw.expected_output) ?? asString(raw.expected),
    actualOutput: isHidden ? null : asString(raw.actual_output) ?? asString(raw.actual),
  };
}

function normalizeArray(
  value: unknown,
  fallbackVisibility?: SubmissionCaseVisibility,
): SubmissionCaseResult[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeCase(item, fallbackVisibility))
    .filter((item): item is SubmissionCaseResult => item !== null);
}

/** 将标准或历史评测详情转换为可安全展示的测试点数组。 */
export function normalizeSubmissionCases(
  details: unknown,
): SubmissionCaseResult[] {
  const record = asRecord(details);
  if (!record) return [];

  if (Array.isArray(record.cases)) {
    return normalizeArray(record.cases);
  }

  // 传统 OI 结果按子任务组织；这里仅读取公开的 case_id/input（题包相对路径）
  // 与资源统计，不尝试展示输入、标准答案或 checker 诊断。
  const oi = asRecord(record.oi);
  if (Array.isArray(oi?.subtasks)) {
    const cases: SubmissionCaseResult[] = [];
    for (const rawSubtask of oi.subtasks) {
      const subtask = asRecord(rawSubtask);
      if (!subtask || !Array.isArray(subtask.cases)) continue;
      cases.push(...normalizeArray(subtask.cases, 'hidden'));
    }
    if (cases.length > 0) return cases;
  }

  const visible = asRecord(record.visible);
  const hidden = asRecord(record.hidden);
  return [
    ...normalizeArray(visible?.cases, 'visible'),
    ...normalizeArray(hidden?.cases, 'hidden'),
  ];
}

/** 判断测试点是否通过，兼容评测器常见的状态命名。 */
export function isSubmissionCasePassed(status: string): boolean {
  return ['accepted', 'ac', 'pass', 'passed', 'ok', 'correct'].includes(
    status.toLowerCase(),
  );
}
