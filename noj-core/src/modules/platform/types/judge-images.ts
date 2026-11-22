/** Judge 镜像白名单的 platform-owned 合同；不依赖 problems 业务模块。 */
export const JUDGE_IMAGE_KINDS = ["evaluator", "solution"] as const;
export type JudgeImageKind = typeof JUDGE_IMAGE_KINDS[number];

export function isValidJudgeImageKind(value: string): value is JudgeImageKind {
  return JUDGE_IMAGE_KINDS.includes(value as JudgeImageKind);
}

export interface CreateJudgeImageInput {
  image: string;
  mode: "exact" | "all_versions";
  kind: JudgeImageKind;
  description?: string;
}

export interface UpdateJudgeImageInput {
  image?: string;
  mode?: "exact" | "all_versions";
  kind?: JudgeImageKind;
  description?: string;
}

export interface JudgeImageResponse {
  id: string;
  image: string;
  mode: string;
  kind: JudgeImageKind;
  description: string;
  created_at: string;
  updated_at: string;
}

function stripImageTag(name: string): string {
  const lastSlash = name.lastIndexOf("/");
  const lastColon = name.lastIndexOf(":");
  return lastColon > lastSlash ? name.slice(0, lastColon) : name;
}

function parseImageRef(image: string): {
  repository: string;
  digest: string | null;
} {
  const trimmed = image.trim();
  const at = trimmed.lastIndexOf("@");
  const rest = at >= 0 ? trimmed.slice(0, at) : trimmed;
  return {
    repository: stripImageTag(rest),
    digest: at >= 0 ? trimmed.slice(at + 1) : null,
  };
}

/** exact 比较完整引用；all_versions 比较 repository，并严格比较已登记 digest。 */
export function isImageInWhitelist(
  image: string,
  whitelist: { image: string; mode: string }[],
): boolean {
  for (const entry of whitelist) {
    if (entry.mode === "exact") {
      if (image === entry.image) return true;
      continue;
    }
    if (entry.mode !== "all_versions") continue;
    const expected = parseImageRef(entry.image);
    const actual = parseImageRef(image);
    if (expected.repository !== actual.repository) continue;
    if (expected.digest) {
      if (actual.digest === expected.digest) return true;
      continue;
    }
    if (stripImageTag(image) === stripImageTag(entry.image)) return true;
  }
  return false;
}
