import type { problems } from "../../../../shared/db/schema.ts";
import type {
  ProblemContentKind,
  ProblemDraftContent,
} from "../../types/problem-content.ts";
import { deriveDraftContentFromProblem } from "../versioning/draft.ts";

/**
 * 把内容补丁合并进草稿内容（Handbook §2.3「内容字段只由发布服务写入投影」）。
 *
 * - `kind` 由目标题型决定（objective / oi / ai），补丁里没有的字段沿用草稿现值，
 *   草稿缺失时回退题目投影；
 * - 客观题小题不接受客户端任意注入：转为客观题时保留草稿内既有小题（旧
 *   `objective_questions` 表已删除，小题由客观题编辑接口写入草稿）；
 * - 题型专属字段按目标 kind 归一，避免 AI 字段残留在 OI 内容里。
 *
 * @throws {BadRequestError} 缺少目标类别必需的配置
 */
export async function mergeProblemContentPatch(
  problem: typeof problems.$inferSelect,
  current: ProblemDraftContent,
  kind: ProblemContentKind,
  patch: Record<string, unknown>,
): Promise<ProblemDraftContent> {
  const base = {
    kind,
    title: (patch.title ??
      current.title ?? problem.title) as string,
    description: (patch.description ??
      current.description ?? problem.description) as string,
    samples: (patch.samples ??
      current.samples ?? []) as ProblemDraftContent["samples"],
  };

  if (kind === "objective") {
    const existing = (current as { questions?: unknown }).questions;
    const questions = Array.isArray(existing) && current.kind === "objective"
      ? existing
      : ((await deriveDraftContentFromProblem({
        ...problem,
        is_objective: true,
        judge_type: "dual",
      })) as { questions?: unknown }).questions ?? [];
    return { ...base, questions };
  }

  const read = (key: string, fallback: unknown) =>
    patch[key] ?? (current as Record<string, unknown>)[key] ?? fallback;
  const runtimeConfig = read("runtime_config", problem.runtime_config);

  // 草稿允许暂时不完整（Handbook §2.4）：缺失运行配置不在这里报错，
  // 由发布预检（preflightProblemDraft）判定是否可发布。
  if (kind === "oi") {
    return { ...base, runtime_config: runtimeConfig };
  }

  return {
    ...base,
    submission_mode: read("submission_mode", problem.submission_mode),
    runtime_config: runtimeConfig,
    template_content: read("template_content", problem.template_content ?? ""),
    artifact_max_size_mb: read(
      "artifact_max_size_mb",
      problem.artifact_max_size_mb,
    ),
    llm_config: read("llm_config", problem.llm_config),
  };
}
