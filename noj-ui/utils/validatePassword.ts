/**
 * Password validation rules extracted from auth pages.
 */
export interface PasswordValidation {
  valid: boolean
  message: string
}

export function validatePassword(password: string): PasswordValidation {
  if (!password) return { valid: false, message: "请输入密码" }
  if (password.length < 12) return { valid: false, message: "密码长度不能少于 12 位" }
  if (!/[a-z]/.test(password)) return { valid: false, message: "密码必须包含至少一个小写字母" }
  if (!/[A-Z]/.test(password)) return { valid: false, message: "密码必须包含至少一个大写字母" }
  if (!/[0-9]/.test(password)) return { valid: false, message: "密码必须包含至少一个数字" }
  return { valid: true, message: "" }
}

export function validatePasswordMatch(password: string, confirm: string): string | null {
  if (!confirm) return "请确认密码"
  if (password !== confirm) return "两次输入的密码不一致"
  return null
}

export function validateEmail(email: string): string | null {
  if (!email.trim()) return "请输入邮箱地址"
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return "邮箱格式不正确"
  return null
}
