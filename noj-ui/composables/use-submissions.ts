/**
 * 提交历史相关共享类型、状态映射和格式化函数。
 * 在用户提交列表页和管理后台间复用。
 */

// API 返回的提列表项类型
export interface SubmissionListItem {
  id: string
  user_id: string
  problem_id: string
  language: string
  file_name: string | null
  status: string
  created_at: string
  problem: {
    id: string
    title: string
  }
  result: {
    status: string
    score: number
    time_ms: number | null
    memory_kb: number | null
  } | null
}

/**
 * 语言标识 → 显示标签映射。
 */
export const languageLabels: Record<string, string> = {
  python3: "Python 3",
  python: "Python",
  cpp: "C++",
  c: "C",
  javascript: "JavaScript",
}

/**
 * 提交流 state 标签颜色。
 */
export const statusColors: Record<string, string> = {
  pending: "#9ca3af",
  judging: "#3b82f6",
}

/**
 * 提交流 state 标签文字。
 */
export const statusLabels: Record<string, string> = {
  pending: "等待评测",
  judging: "评测中",
}

/**
 * 评测结果状态 → 显示标签。
 */
export const resultLabels: Record<string, string> = {
  Accepted: "答案正确",
  WrongAnswer: "答案错误",
  TimeLimitExceeded: "超出时间限制",
  MemoryLimitExceeded: "超出内存限制",
  RuntimeError: "运行时错误",
  SystemError: "系统错误",
}

/**
 * 评测结果状态 → 标签颜色。
 */
export const resultColors: Record<string, string> = {
  Accepted: "#10b981",
  WrongAnswer: "#ef4444",
  TimeLimitExceeded: "#f59e0b",
  MemoryLimitExceeded: "#f59e0b",
  RuntimeError: "#ef4444",
  SystemError: "#ef4444",
}

/**
 * 获取状态标签的颜色。
 * 优先使用 result.status 的颜色，回退到提交流 state 的颜色。
 */
export function getStatusColor(
  status: string,
  resultStatus: string | undefined | null,
): string {
  if (resultStatus && resultColors[resultStatus]) {
    return resultColors[resultStatus]
  }
  return statusColors[status] || "#6b7280"
}

/**
 * 获取状态标签的文字。
 * 优先使用 result.status 的标，回退到提交流 state 的标签。
 */
export function getStatusLabel(
  status: string,
  resultStatus: string | undefined | null,
): string {
  if (resultStatus && resultLabels[resultStatus]) {
    return resultLabels[resultStatus]
  }
  return statusLabels[status] || status
}

/**
 * 格式化得分（API 返回 ×100 的整数值）。
 */
export function formatScore(raw: number | undefined | null): string {
  if (raw === undefined || raw === null) return "--"
  return (raw / 100).toFixed(1)
}

/**
 * 格式化时间（毫秒 → 可读格式）。
 */
export function formatTime(ms: number | undefined | null): string {
  if (ms === undefined || ms === null) return "--"
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

/**
 * 格式化内存（KB → 可读格式）。
 */
export function formatMemory(kb: number | undefined | null): string {
  if (kb === undefined || kb === null) return "--"
  if (kb < 1024) return `${kb}KB`
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(1)}MB`
  return `${(kb / 1024 / 1024).toFixed(2)}GB`
}

/**
 * 获取语言显示标签。
 */
export function getLanguageLabel(lang: string): string {
  return languageLabels[lang] || lang
}
