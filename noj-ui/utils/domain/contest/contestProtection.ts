/** 赛题保护的公开元数据；不包含题面或评测内容。 */
export interface ContestProtectionRef {
  contestId: string;
  publicId: string;
  title: string;
}

/** 从服务端 403 中提取可展示的比赛入口，拒绝任意外部地址。 */
export function contestProtectionFromError(
  error: unknown,
): ContestProtectionRef[] | null {
  const data = (error as { data?: { code?: string; contests?: unknown } } | null)?.data;
  if (data?.code !== 'CONTEST_PROBLEM_RESTRICTED') return null;
  if (!Array.isArray(data.contests)) return [];
  return data.contests.filter((ref): ref is ContestProtectionRef =>
    ref != null && typeof ref === 'object' &&
    typeof ref.contestId === 'string' &&
    typeof ref.publicId === 'string' && /^ct-[a-z0-9]+$/.test(ref.publicId) &&
    typeof ref.title === 'string'
  );
}
