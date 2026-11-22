/**
 * Password validation rules extracted from auth pages.
 */
export interface PasswordValidation {
  valid: boolean;
  message: string;
}

export interface PasswordValidationContext {
  username?: string;
  email?: string;
}

export function validatePassword(
  password: string,
  context: PasswordValidationContext = {},
): PasswordValidation {
  if (!password) return { valid: false, message: '请输入密码' };
  if (password.length < 8) return { valid: false, message: '密码长度不能少于 8 位' };
  if (!/[a-z]/.test(password)) return { valid: false, message: '密码必须包含至少一个小写字母' };
  if (!/[A-Z]/.test(password)) return { valid: false, message: '密码必须包含至少一个大写字母' };
  if (!/[0-9]/.test(password)) return { valid: false, message: '密码必须包含至少一个数字' };
  const normalizedPassword = password.toLowerCase();
  const normalizedUsername = context.username?.trim().toLowerCase();
  if (normalizedUsername && normalizedPassword === normalizedUsername) {
    return { valid: false, message: '密码不能与用户名相同' };
  }
  const emailPrefix = context.email?.split('@')[0]?.trim().toLowerCase();
  if (emailPrefix && normalizedPassword === emailPrefix) {
    return { valid: false, message: '密码不能与邮箱前缀相同' };
  }
  return { valid: true, message: '' };
}

export function validatePasswordMatch(password: string, confirm: string): string | null {
  if (!confirm) return '请确认密码';
  if (password !== confirm) return '两次输入的密码不一致';
  return null;
}

export function validateEmail(email: string): string | null {
  if (!email.trim()) return '请输入邮箱地址';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return '邮箱格式不正确';
  return null;
}
