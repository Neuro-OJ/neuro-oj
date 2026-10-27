import {
  and,
  asc,
  count,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../../../../shared/db/connection.ts";
import {
  domainProblemBindings,
  domains,
  problems,
  problemShareSettings,
  problemTags,
  problemVersions,
  tags,
  users,
} from "../../../../shared/db/schema.ts";
import { loadWorkspace } from "../../../access/contracts/cross-module/workspace_services_access.ts";
import {
  domainProblemProgressWhere,
  getProblemSubmissionSummaries,
} from "../../../access/submission-policy.ts";
import { isValidDifficulty } from "../../types/problems.ts";
import { unendedPublicContestForProblem } from "../../../access/contest-policy.ts";
import type { ProblemContentV1 } from "../../types/problem-content.ts";
import {
  projectProblemContent,
  trimProblemContentForViewer,
} from "../versioning/version-read-view.ts";
import {
  BadRequestError,
  NotFoundError,
} from "../../../../shared/base/errors.ts";
import { resolveDomainProblem } from "./problem-binding-access.ts";
import { domainProblemReference } from "./problem-reference.ts";
import { problemAuthoringRestrictedByContest } from "./problem-contest-authoring.ts";

/** 域题库分页：授权、共享撤销及比赛保密都在分页和计数前过滤。 */
export async function listDomainProblems(
  slug: string,
  actorId: string | null,
  query: {
    page: number;
    limit: number;
    keyword?: string;
    difficulty?: string;
    kind?: string;
    progress?: string;
    tag_id?: string;
    judge_backend?: string;
  },
) {
  const db = getDb();
  const workspace = await loadWorkspace(slug, actorId);
  const source = alias(domains, "problem_source_domain");
  const binding = domainProblemBindings;
  const canEdit = workspace.platformAdmin ||
    workspace.context.domainPermissions.has("problem:write_any");
  if (query.difficulty && !isValidDifficulty(query.difficulty)) {
    throw new BadRequestError("题目难度非法");
  }
  if (query.kind && !["oi", "ai", "objective"].includes(query.kind)) {
    throw new BadRequestError("题型非法");
  }
  if (
    query.judge_backend &&
    !["dual", "oi-native", "oi-wasm"].includes(query.judge_backend)
  ) {
    throw new BadRequestError("评测后端非法");
  }
  if (
    query.progress &&
    !["solved", "attempted", "unseen"].includes(query.progress)
  ) throw new BadRequestError("本人状态非法");
  if (query.progress && !actorId) {
    throw new BadRequestError("请登录后筛选本人状态");
  }
  const scope = {
    domainId: workspace.domain.id,
    member: !!workspace.membership || workspace.platformAdmin,
  };
  const ownEditable = and(
    eq(binding.kind, "owned"),
    canEdit
      ? sql`true`
      : actorId && workspace.context.domainPermissions.has("problem:write_own")
      ? eq(problems.owner_id, actorId)
      : sql`false`,
  );
  const algorithmVisible = or(
    ownEditable,
    actorId
      ? domainProblemProgressWhere(scope, problems.id, actorId, "solved")
      : sql`false`,
  );
  const keyword = query.keyword?.trim();
  const backend = sql<
    string | null
  >`CASE WHEN ${problemVersions.content}->>'kind'='oi'
    THEN 'oi-' || (${problemVersions.content}->'runtime_config'->>'backend')
    WHEN ${problemVersions.content}->>'kind'='ai' THEN 'dual' ELSE NULL END`;
  const authorized = and(
    eq(binding.domain_id, workspace.domain.id),
    isNull(binding.disabled_at),
    workspace.membership || workspace.platformAdmin
      ? undefined
      : eq(binding.visibility, "public"),
    isNotNull(problems.latest_version_id),
    or(
      and(
        eq(binding.kind, "owned"),
        eq(problems.domain_id, workspace.domain.id),
        canEdit ? undefined : or(
          sql`NOT ${
            unendedPublicContestForProblem(
              problems.id,
              sql`${workspace.domain.id}`,
            )
          }`,
          actorId &&
            workspace.context.domainPermissions.has("problem:write_own")
            ? eq(problems.owner_id, actorId)
            : undefined,
        ),
      ),
      and(
        eq(binding.kind, "shared"),
        eq(problems.visibility, "public"),
        sql`${source.status} <> 'suspended'`,
        sql`${source.configuration}->>'access' = 'public'`,
        eq(problemShareSettings.enabled, true),
        sql`(${problemShareSettings.scope} = 'all' OR EXISTS (SELECT 1 FROM problem_share_targets grant_target WHERE grant_target.problem_id = ${problems.id} AND grant_target.domain_id = ${workspace.domain.id}))`,
        sql`EXISTS (SELECT 1 FROM domain_problem_bindings source_binding WHERE source_binding.problem_id = ${problems.id} AND source_binding.domain_id = ${source.id} AND source_binding.kind = 'owned' AND source_binding.visibility = 'public' AND source_binding.disabled_at IS NULL)`,
        sql`NOT ${unendedPublicContestForProblem(problems.id, source.id)}`,
      ),
    ),
  );
  const visible = and(
    authorized,
    query.judge_backend ? eq(backend, query.judge_backend) : undefined,
    keyword
      ? or(
        ilike(sql`${problemVersions.content}->>'title'`, `%${keyword}%`),
        eq(sql`${problems.number}::text`, keyword),
        eq(sql`${source.slug} || ':' || ${problems.number}`, keyword),
      )
      : undefined,
    query.difficulty ? eq(problems.difficulty, query.difficulty) : undefined,
    query.kind
      ? eq(sql`${problemVersions.content}->>'kind'`, query.kind)
      : undefined,
    query.progress && actorId
      ? domainProblemProgressWhere(
        scope,
        problems.id,
        actorId,
        query.progress as "solved" | "attempted" | "unseen",
      )
      : undefined,
    query.tag_id
      ? sql`EXISTS (SELECT 1 FROM problem_tags filtered_tags JOIN tags filtered_tag ON filtered_tag.id=filtered_tags.tag_id
      WHERE filtered_tags.problem_id=${problems.id} AND filtered_tags.tag_id=${query.tag_id}
      AND (filtered_tag.kind='problem' OR ${algorithmVisible}))`
      : undefined,
  );
  const join = (where = visible) =>
    db.select({
      problem_id: sql<string>`${problems.id}`.as("problem_id"),
      source_domain_id: source.id,
      source_slug: source.slug,
      number: problems.number,
      title: sql<string>`${problemVersions.content}->>'title'`,
      kind: sql<string>`${problemVersions.content}->>'kind'`,
      difficulty: problems.difficulty,
      can_edit_tags: sql<boolean>`${ownEditable}`,
      can_view_algorithm_tags: sql<boolean>`${algorithmVisible}`.as(
        "can_view_algorithm_tags",
      ),
      judge_backend: backend.as("judge_backend"),
      limits: sql<
        { time_limit_ms: number; memory_limit_mb: number } | null
      >`CASE
        WHEN ${problemVersions.content}->>'kind'='oi' THEN json_build_object(
          'time_limit_ms',${problemVersions.content}->'runtime_config'->'time_limit_ms',
          'memory_limit_mb',${problemVersions.content}->'runtime_config'->'memory_limit_mb')
        WHEN ${problemVersions.content}->>'kind'='ai' THEN json_build_object(
          'time_limit_ms',${problemVersions.content}->'runtime_config'->'evaluator'->'time_limit_ms',
          'memory_limit_mb',${problemVersions.content}->'runtime_config'->'evaluator'->'memory_limit_mb')
        ELSE NULL END`.as("limits"),
      version_id: problemVersions.id,
      version: problemVersions.version,
      binding_id: binding.id,
      revision: binding.revision,
    }).from(binding).innerJoin(problems, eq(problems.id, binding.problem_id))
      .innerJoin(source, eq(source.id, problems.domain_id))
      .innerJoin(
        problemVersions,
        and(
          eq(problemVersions.problem_id, problems.id),
          eq(
            problemVersions.id,
            sql`CASE WHEN ${binding.effective_version_mode} = 'exact' THEN ${binding.required_version_id} ELSE ${problems.latest_version_id} END`,
          ),
        ),
      )
      .leftJoin(
        problemShareSettings,
        eq(problemShareSettings.problem_id, problems.id),
      ).where(where);
  const candidates = join().as("authorized_domain_problems");
  const accessible = join(authorized).as("accessible_domain_problems");
  const [[total], rows, availableTags] = await Promise.all([
    db.select({ total: count() }).from(candidates),
    join().orderBy(asc(source.slug), asc(problems.number), asc(problems.id))
      .limit(query.limit).offset((query.page - 1) * query.limit),
    db.selectDistinct({ id: tags.id, name: tags.name, kind: tags.kind }).from(
      tags,
    )
      .innerJoin(problemTags, eq(tags.id, problemTags.tag_id))
      .innerJoin(
        accessible,
        eq(sql`accessible_domain_problems.problem_id`, problemTags.problem_id),
      )
      .where(
        or(
          eq(tags.kind, "problem"),
          eq(sql`accessible_domain_problems.can_view_algorithm_tags`, true),
        ),
      )
      .orderBy(asc(tags.kind), asc(tags.name), asc(tags.id)),
  ]);
  const ids = rows.map((row) => row.problem_id);
  const [statistics, labels] = await Promise.all([
    getProblemSubmissionSummaries(scope, ids, actorId),
    ids.length
      ? db.select({
        problem_id: problemTags.problem_id,
        id: tags.id,
        name: tags.name,
        kind: tags.kind,
      })
        .from(problemTags).innerJoin(tags, eq(tags.id, problemTags.tag_id))
        .where(inArray(problemTags.problem_id, ids)).orderBy(asc(tags.name))
      : Promise.resolve([]),
  ]);
  const summaries = new Map(statistics.map((row) => [row.problem_id, row]));
  return {
    page: query.page,
    limit: query.limit,
    total: total.total,
    tags: availableTags,
    items: rows.map((row) => {
      const summary = summaries.get(row.problem_id);
      const problemLabels = labels.filter((label) =>
        label.problem_id === row.problem_id
      );
      const visibleLabels = problemLabels.filter((label) =>
        label.kind === "problem" || row.can_edit_tags || summary?.solved
      );
      return ({
        reference: domainProblemReference(
          {
            id: row.problem_id,
            domain_id: row.source_domain_id,
            number: row.number,
          },
          row.source_slug,
          workspace.domain.id,
        ),
        title: row.title,
        kind: row.kind,
        version_id: row.version_id,
        version: row.version,
        binding_id: row.binding_id,
        policy_revision: row.revision,
        difficulty: row.difficulty,
        judge_backend: row.judge_backend,
        limits: row.limits,
        tags: visibleLabels.map(({ id, name, kind }) => ({ id, name, kind })),
        has_hidden_algorithm_tags:
          visibleLabels.length !== problemLabels.length,
        progress: actorId
          ? summary?.solved
            ? "solved"
            : summary?.attempted
            ? "attempted"
            : "unseen"
          : null,
        submit_count: summary?.submit_count ?? 0,
        best_score: actorId ? summary?.best_score ?? null : null,
        valid_submissions: summary?.valid_submissions ?? 0,
        accepted_submissions: summary?.accepted_submissions ?? 0,
      });
    }),
  };
}

/** 读取目标域选择的不可变版本；目标域管理员不能获得共享题的评测配置与答案。 */
export async function readDomainProblem(
  slug: string,
  reference: string,
  actorId: string | null,
  versionId?: string,
) {
  const resolved = await resolveDomainProblem(slug, reference, actorId, {
    versionId,
  });
  const canEdit = resolved.binding.kind === "owned" &&
    (resolved.platformAdmin ||
      resolved.context.domainPermissions.has("problem:write_any") ||
      actorId === resolved.problem.owner_id &&
        resolved.context.domainPermissions.has("problem:write_own")) &&
    !await problemAuthoringRestrictedByContest(
      resolved,
      resolved.problem.id,
      getDb(),
    );
  const content = resolved.version.content as ProblemContentV1;
  const fields = projectProblemContent(content, false);
  const [summaries, labels, [owner]] = await Promise.all([
    getProblemSubmissionSummaries(
      {
        domainId: resolved.domain.id,
        member: !!resolved.membership || resolved.platformAdmin,
      },
      [resolved.problem.id],
      actorId,
    ),
    getDb().select({ id: tags.id, name: tags.name, kind: tags.kind })
      .from(problemTags).innerJoin(tags, eq(tags.id, problemTags.tag_id))
      .where(eq(problemTags.problem_id, resolved.problem.id))
      .orderBy(asc(tags.kind), asc(tags.name)),
    getDb().select({
      id: users.id,
      username: users.username,
      avatar_url: users.avatar_url,
    })
      .from(users).where(eq(users.id, resolved.problem.owner_id)),
  ]);
  const summary = summaries[0];
  const visibleLabels = labels.filter((label) =>
    label.kind === "problem" || canEdit || summary?.solved
  );
  return {
    reference: resolved.reference,
    binding_id: resolved.binding.id,
    policy_revision: resolved.binding.revision,
    effective_version_mode: resolved.binding.effective_version_mode,
    required_version_id: resolved.binding.required_version_id,
    answer_version_id: resolved.answerVersionId,
    visibility: resolved.binding.visibility,
    can_share: resolved.binding.kind === "owned" &&
      (resolved.platformAdmin ||
        resolved.context.domainPermissions.has("problem:share")),
    version_id: resolved.version.id,
    version: resolved.version.version,
    can_edit: canEdit,
    difficulty: resolved.problem.difficulty,
    judge_backend: fields.judge_backend,
    owner: owner ?? null,
    tags: visibleLabels,
    has_hidden_algorithm_tags: visibleLabels.length !== labels.length,
    statistics: {
      submit_count: summary?.submit_count ?? 0,
      valid_submissions: summary?.valid_submissions ?? 0,
      accepted_submissions: summary?.accepted_submissions ?? 0,
      progress: actorId
        ? summary?.solved
          ? "solved"
          : summary?.attempted
          ? "attempted"
          : "unseen"
        : null,
    },
    limits: fields.limits,
    supported_languages: fields.supported_languages ?? [],
    submission_mode: content.kind === "ai" ? content.submission_mode : "code",
    content: trimProblemContentForViewer(
      resolved.version.content as ProblemContentV1,
      canEdit,
    ),
  };
}

/** 模板只取当前使用域作答版本，不能通过下载入口绕过撤销或版本确认。 */
export async function readDomainProblemTemplate(
  slug: string,
  reference: string,
  actorId: string | null,
  requestedVersionId?: string,
) {
  const resource = await resolveDomainProblem(slug, reference, actorId, {
    versionId: requestedVersionId,
  });
  const content = resource.version.content as ProblemContentV1;
  if (content.kind === "ai" && content.submission_mode === "ui") {
    throw new NotFoundError("界面题不公开评测脚本模板");
  }
  return {
    version_id: resource.version.id,
    template_content: content.kind === "ai" ? content.template_content : "",
  };
}

/** 版本目录只返回不可变版本依据，所有读取先重新验证使用域及共享。 */
export async function listDomainProblemVersions(
  slug: string,
  reference: string,
  actorId: string | null,
  page: number,
  limit: number,
) {
  const resource = await resolveDomainProblem(slug, reference, actorId);
  const db = getDb(),
    condition = eq(problemVersions.problem_id, resource.problem.id);
  const [[total], items] = await Promise.all([
    db.select({ total: count() }).from(problemVersions).where(condition),
    db.select({
      version_id: problemVersions.id,
      version: problemVersions.version,
      change_note: problemVersions.change_note,
      published_at: problemVersions.published_at,
    })
      .from(problemVersions).where(condition).orderBy(
        sql`${problemVersions.version} DESC`,
      ).offset((page - 1) * limit).limit(limit),
  ]);
  return {
    items,
    total: total.total,
    page,
    limit,
    answer_version_id: resource.version.id,
  };
}
