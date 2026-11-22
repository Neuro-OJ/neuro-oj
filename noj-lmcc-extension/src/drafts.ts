const DRAFT_PREFIX = "neuroOj.draft:";

/** 模板草稿键：前缀 + JSON 数组（服务器、账号、域、题号、版本、语言）。 */
export function draftKey(
  server: string,
  actor: string,
  slug: string,
  reference: string,
  versionId: string,
): string {
  return `${DRAFT_PREFIX}${JSON.stringify([server, actor, slug, reference, versionId, "python3"])}`;
}

/** 筛出属于指定服务器与账号的草稿键，供退出登录时清理；格式不符的键一律不碰。 */
export function draftKeysToClear(
  keys: readonly string[],
  server: string,
  actor: string,
): string[] {
  return keys.filter((key) => {
    if (!key.startsWith(DRAFT_PREFIX)) return false;
    let parts: unknown;
    try {
      parts = JSON.parse(key.slice(DRAFT_PREFIX.length));
    } catch {
      return false;
    }
    return (
      Array.isArray(parts) &&
      typeof parts[0] === "string" &&
      typeof parts[1] === "string" &&
      parts[0] === server &&
      parts[1] === actor
    );
  });
}
