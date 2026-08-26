/**
 * 提交详情中的测试点结果归一化工具。
 *
 * 新结果使用 details.cases；历史结果可能使用 visible/hidden 分组和
 * id/expected/actual 字段。归一化时统一字段，并清除隐藏用例的敏感输出。
 */

export type SubmissionCaseVisibility = 'visible' | 'hidden';

export interface SubmissionCaseResult {
  caseId: string;
  status: string;
  visibility: SubmissionCaseVisibility;
  timeMs: number | null;
  memoryKb: number | null;
  input: string | null;
  expectedOutput: string | null;
  actualOutput: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function asNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function resolveStatus(raw: Record<string, unknown>): string | null {
  const status = asString(raw.status);
  if (status) return status;
  if (typeof raw.content_ok === 'boolean') return raw.content_ok ? 'Accepted' : 'WrongAnswer';
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
export function normalizeSubmissionCases(details: unknown): SubmissionCaseResult[] {
  const record = asRecord(details);
  if (!record) return [];

  if (Array.isArray(record.cases)) {
    return normalizeArray(record.cases);
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
  return ['accepted', 'pass', 'passed', 'ok', 'correct'].includes(status.toLowerCase());
}
