import type { WorkspaceConfiguration, WorkspaceLimits, WorkspacePreset, WorkspaceRecord } from './workspace.ts';
export interface InstanceSetting {
  key: string;
  effective_value: unknown;
  updated_at: string | null;
  source: 'db' | 'env' | 'default';
}
export interface InstanceDomain extends WorkspaceRecord {
  owner_username: string;
  created_at: string;
  updated_at: string;
}
export interface DomainCreationRequest {
  id: string;
  applicant_id: string;
  applicant_username: string;
  applicant_deleted: boolean;
  slug: string;
  name: string;
  preset: WorkspacePreset;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  domain_id: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
}
export interface GovernancePage<T> {
  data: T[];
  pagination: { page: number; per_page: number; total: number; total_pages: number };
}
export const WORKSPACE_LIMIT_FIELDS = [
  { key: 'members', label: '成员', unit: '人', max: 2147483647 },
  { key: 'problems', label: '题库条目', unit: '道', max: 2147483647 },
  { key: 'storage_bytes', label: '存储', unit: '字节', max: Number.MAX_SAFE_INTEGER },
  { key: 'submissions_per_minute', label: '每分钟正式提交', unit: '次', max: 2147483647 },
] as const;
export const DOMAIN_STATUS_LABELS = { active: '正常', archived: '归档', suspended: '暂停' } as const;
export interface InstancePolicyDraft {
  instance_access: 'public' | 'authenticated';
  instance_registration_mode: 'open' | 'invite' | 'admin_only';
  default_domain_slug: string;
  domain_creation_policy: 'admin' | 'approval' | 'open';
  domain_creation_limit: number;
  allow_domain_registration_invites: boolean;
  instance_allowed_modules: WorkspaceConfiguration['features'];
  domain_default_limits: WorkspaceLimits;
  domain_limit_caps: WorkspaceLimits;
  domain_llm_quota_caps: Record<
    'day' | 'month',
    { max_calls: number | null; max_tokens: number | null; max_cost: number | null }
  >;
}
/** 配置注册表已验证这些固定字段；仅将既有文本配置转换为表单值。 */
export function instancePolicyDraft(settings: InstanceSetting[]): InstancePolicyDraft {
  const value = (key: string) => settings.find((setting) => setting.key === key)!.effective_value;
  return {
    instance_access: value('instance_access') as InstancePolicyDraft['instance_access'],
    instance_registration_mode: value(
      'instance_registration_mode',
    ) as InstancePolicyDraft['instance_registration_mode'],
    default_domain_slug: value('default_domain_slug') as string,
    domain_creation_policy: value('domain_creation_policy') as InstancePolicyDraft['domain_creation_policy'],
    domain_creation_limit: value('domain_creation_limit') as number,
    allow_domain_registration_invites: value('allow_domain_registration_invites') as boolean,
    instance_allowed_modules: JSON.parse(value('instance_allowed_modules') as string),
    domain_default_limits: JSON.parse(value('domain_default_limits') as string),
    domain_limit_caps: JSON.parse(value('domain_limit_caps') as string),
    domain_llm_quota_caps: JSON.parse(value('domain_llm_quota_caps') as string),
  };
}
export function instanceSettingValue(draft: InstancePolicyDraft, key: keyof InstancePolicyDraft) {
  const value = draft[key];
  return typeof value === 'object' ? JSON.stringify(value) : value;
}
