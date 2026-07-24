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
  finished: "#10b981",
  error: "#ef4444",
}

/**
 * 提交流 state 标签文字。
 */
export const statusLabels: Record<string, string> = {
  pending: "等待评测",
  judging: "评测中",
  finished: "已完成",
  error: "系统错误",
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
  CompileError: "编译错误",
  OutputLimitExceeded: "输出超出限制",
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
  CompileError: "#a855f7",
  OutputLimitExceeded: "#f97316",
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

/**
 * 评测结果详细定义（含图标和样式类）。
 */
export interface ResultDef {
  label: string
  icon: string
  class: string
}

/**
 * 评测结果状态 → 详细定义映射。
 */
export const resultDefMap: Record<string, ResultDef> = {
  Accepted: { label: "答案正确", icon: "check", class: "accepted" },
  WrongAnswer: { label: "答案错误", icon: "x", class: "wrong" },
  TimeLimitExceeded: { label: "超出时间限制", icon: "alert", class: "tle" },
  MemoryLimitExceeded: { label: "超出内存限制", icon: "alert", class: "mle" },
  RuntimeError: { label: "运行时错误", icon: "x", class: "re" },
  SystemError: { label: "系统错误", icon: "x", class: "se" },
  CompileError: { label: "编译错误", icon: "x", class: "re" },
  OutputLimitExceeded: { label: "输出超出限制", icon: "alert", class: "tle" },
}

/**
 * 获取评测结果详细定义。
 */
export function getResultDef(status: string | undefined): ResultDef {
  if (!status) return { label: status ?? "未知", icon: "x", class: "se" }
  return resultDefMap[status] ?? { label: status, icon: "x", class: "se" }
}

/**
 * 评测判定的 Tailwind 样式类。
 */
export const verdictClasses: Record<string, string> = {
  accepted: "bg-green-50 border border-green-200 text-green-700",
  wrong: "bg-red-50 border border-red-200 text-red-800",
  tle: "bg-orange-50 border border-orange-200 text-orange-800",
  mle: "bg-orange-50 border border-orange-200 text-orange-800",
  re: "bg-red-50 border border-red-200 text-red-800",
  se: "bg-red-50 border border-red-200 text-red-800",
}

/**
 * 提交状态徽章的 Tailwind 样式类。
 */
export const statusBadgeColors: Record<string, string> = {
  pending: "bg-gray-50 text-slate-500 border border-border",
  judging: "bg-blue-50 text-blue-700 border border-blue-200",
  error: "bg-red-50 text-red-800 border border-red-200",
}

/**
 * 格式化 ISO 时间为中文可读格式。
 */
export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "--"
  const d = new Date(iso)
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}
