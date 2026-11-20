/** 经 Core 验证的完整用户；可读 Session Cookie 只用于启动提示。 */
export interface AuthUser {
  id: string;
  username: string;
  email: string;
  role: string;
  is_admin: boolean;
  must_change_password: boolean;
  email_verified: boolean;
  has_local_password: boolean;
  tfa_enabled?: boolean;
  avatar_url?: string | null;
  permissions?: string[];
  legal?: import('./legalConsent.ts').LegalStatusMap;
  created_at: string;
  updated_at: string;
}
