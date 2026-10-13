/**
 * 统一题目包导入服务（problem-bundle-import）。
 *
 * 编排流程：解析 zip → 校验 manifest → 剥离元数据重建评测包 →
 * storage 注册 → 落库元数据（更新复用 updateProblem；创建复用 createProblem 校验语义）。
 *
 * 语义：
 * - manifest 不含 id：题目主键一律由服务端生成 UUID。
 * - manifest.number 仅 admin 生效，作为幂等键：按 (type, number) 匹配既有题目
 *   → 更新（元数据 + 替换评测包）；未命中 → 创建；(type, number) 由 DB 联合
 *   旧分类仍用于格式 1 兼容，编号统一由默认域原子游标分配。
 * - 非 admin 提供 manifest.number 直接拒绝（400）：普通用户导入只能创建新题
 *   （number 自动分配），避免"上传以为更新、实则新建"的误导。
 * - 题面唯一事实来源是数据库：statement.md 与 manifest.description 仅用于
 *   本次导入写入，评测包中不含这两个元数据文件。
 */

import type { Context } from "hono";
import { and, eq, isNull, or } from "drizzle-orm";
import { getDb } from "./../../../../shared/db/connection.ts";
import { problems, problemTags } from "./../../../../shared/db/schema.ts";
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "./../../../../shared/base/errors.ts";
import { getLogger } from "@logtape/logtape";

const logger = getLogger(["noj", "catalog"]);
import { checkPermission } from "./../../../identity/index.ts";
import { uploadStorageObjectWithReservation } from "./../../../system/index.ts";
import {
  parseBundleZip,
  readBundleTemplate,
  stripMetadataEntries,
} from "./../bundle-parser.ts";
import {
  DEFAULT_TEMPLATE_FILE,
  isValidProblemBundleName,
  MAX_TEMPLATE_BYTES,
  type ObjectiveQuestionBundleInput,
  type ProblemBundleManifest,
  validateBundleManifest,
  validateObjectiveQuestions,
} from "./../../types/problem-bundle.ts";
import {
  isOiRuntimeConfig,
  type ProblemResponseWithTags,
  type ProblemRuntimeConfig as RuntimeConfig,
} from "./../../types/problems.ts";
import type { ObjectiveQuestionSnapshot } from "./../../types/problem-content.ts";
import {
  assertProblemEditPermission,
  createProblem,
  updateProblem,
} from "./problems-crud.ts";
import {
  DEFAULT_DOMAIN_ID,
  DEFAULT_DOMAIN_SLUG,
  ensureDefaultWorkspace,
} from "../../../workspace/index.ts";
import {
  bindCreatedDomainProblem,
  prepareDomainProblemCreation,
} from "../workspace/problem-create.ts";
import { validateJudgeImageWithKind } from "../../../system/index.ts";
import {
  assertSensitiveFieldPermissions,
  enforceResourceLimits,
} from "./problem-field-guard.ts";
import { validateProblemTagIds } from "./problems-tags.ts";
import { judgeOptions } from "../../../objective/index.ts";
import { getProblem } from "./problems-list.ts";
import { getTagIdsByNames, listTags } from "../tags.ts";
import { logAudit } from "../../../system/index.ts";
import { assertLlmLimitsWithinDefault } from "../../../gateway/index.ts";
import { MAX_SUPPORT_PACKAGE_SIZE } from "../support-package.ts";
import { ROOT_USER_ID } from "./../../../../shared/base/constants.ts";
import {
  deriveDraftContentFromProblem,
  draftRevisionConflict,
  draftRevisionRequired,
  getProblemDraft,
  loadProblemIdentity,
  replaceDraftObjectsForRole,
  saveProblemDraft,
  saveProblemDraftWithObjects,
} from "../versioning/draft.ts";
import { deleteStorageObject } from "../../../system/index.ts";
import { publishProblemVersion } from "../versioning/publish.ts";

/**
 * 把当前题目投影（题面/配置/模板/客观题小题）同步进**共享草稿**。
 *
 * 导入流程是"写入者"：它先把内容落成题目投影，再调用本函数把同一份内容写进草稿，
 * 使 `--publish` 与后续编辑都以草稿为起点。客观题小题的 `key` 取旧小题 UUID
 * （与迁移基线规则一致，保证历史答案可按 key 匹配）。
 */
export async function syncProblemDraftFromProjection(
  problemId: string,
  actorId?: string | null,
): Promise<number> {
  const db = getDb();
  const [identity] = await db.select().from(problems).where(
    eq(problems.id, problemId),
  ).limit(1);
  if (!identity) throw new BadRequestError("题目不存在");
  const content = await deriveDraftContentFromProblem(identity);
  const draft = await getProblemDraft(problemId, identity);
  const saved = await saveProblemDraft(problemId, {
    content,
    expectedRevision: draft.revision,
    actorId: actorId ?? null,
  });
  return saved.revision;
}

/**
 * 导入后显式发布当前内容为新版本（`problems import --publish`）。
 *
 * 内容事实源是**草稿**：编程题与客观题导入都直接写草稿（客观题小题 key 取
 * 现有/生成的 UUID），此处发布当前草稿 revision。相同内容重复发布返回既有版本
 * （`unchanged: true`），不制造空版本。
 */
export async function publishImportedProblem(
  problemId: string,
  actorId?: string | null,
  changeNote = "题目包导入",
): Promise<{ version_id: string; version: number; unchanged: boolean }> {
  const identity = await loadProblemIdentity(problemId);
  const revision = (await getProblemDraft(problemId, identity)).revision;
  const published = await publishProblemVersion(problemId, {
    expectedRevision: revision,
    changeNote,
    actorId: actorId ?? null,
  });
  return {
    version_id: published.version_id,
    version: published.version,
    unchanged: published.unchanged,
  };
}

/** 导入执行者（CLI 场景无 Hono Context）。 */
export interface BundleImportActor {
  userId?: string;
  userRole?: string;
}

/**
 * 构建评测包存储键（与 support-package.ts 的 `packages/<problem_id>.zip` 约定一致）。
 */
function buildPackageKey(problemId: string): string {
  return `packages/${problemId}.zip`;
}

/**
 * 按标签名解析为标签 id 列表（issue #223：manifest.tags 取代 categories）。
 *
 * 与既有导入语义一致：不存在的标签名被忽略并记录 warning。
 */
async function resolveTagIds(
  names: string[] | undefined,
): Promise<string[]> {
  if (!names || names.length === 0) return [];

  const uniqueNames = [...new Set(names)];
  const ids = await getTagIdsByNames(uniqueNames);
  if (ids.length !== uniqueNames.length) {
    const all = await listTags();
    const known = new Set(all.map((t) => t.name));
    for (const name of uniqueNames) {
      if (!known.has(name)) {
        logger.warn('题目导入：标签 "{name}" 不存在，已忽略', { name });
      }
    }
  }
  return ids;
}

/**
 * 判断执行者是否 admin。
 *
 * 有 Hono Context 时走 RBAC 权限检查（`problem:write_any` 为 admin 级权限），
 * 否则退化为 userRole 判断（CLI 场景）。
 */
function isAdminActor(
  actor: BundleImportActor,
  c?: Context,
): boolean | Promise<boolean> {
  if (c) {
    return checkPermission(c, "problem:write_any");
  }
  return actor.userRole === "admin";
}

/**
 * 统一题目包导入入口。
 *
 * @param file 上传的 zip（导入载体，根级含 problem.json/evaluate.py）
 * @param actor 执行者（userId/userRole）
 * @param c 可选 Hono Context（HTTP 路由场景传入；CLI 场景为 undefined）
 * @returns 导入/更新后的题目响应
 * @throws {ValidationError} 非 zip / 超大小
 * @throws {BadRequestError} 格式/校验失败
 * @throws {ForbiddenError} 权限不足（由 createProblem/updateProblem 抛出）
 */
export async function importProblemBundle(
  file: { name: string; data: Uint8Array },
  actor: BundleImportActor,
  c?: Context,
  target?: string | {
    /** 目标题目：内容写入该题的**共享草稿**，不新建题目。 */
    problemId: string;
    /** 客户端编辑基线（target 模式下必填）：缺失 428、过时 409。 */
    expectedRevision?: number | null;
  },
): Promise<ProblemResponseWithTags & { warnings?: string[] }> {
  const targetProblemId = typeof target === "string"
    ? target
    : target?.problemId;
  const targetExpectedRevision = typeof target === "string"
    ? undefined
    : target?.expectedRevision;

  // 1. 基础校验：后缀 + 大小（与 support-package 上传约定一致）
  if (!isValidProblemBundleName(file.name)) {
    throw new ValidationError("仅支持 .zip 格式文件");
  }
  if (file.data.length > MAX_SUPPORT_PACKAGE_SIZE) {
    throw new ValidationError(
      `导入包大小超过限制（最大 ${
        (MAX_SUPPORT_PACKAGE_SIZE / 1024 / 1024).toFixed(0)
      }MB）`,
    );
  }

  // 2. 解析 + 校验（含 ZIP 安全与 manifest 结构校验、command 默认注入）
  const parsed = parseBundleZip(file.data);
  const manifest = validateBundleManifest(parsed.manifest);

  // 3. 题面：statement.md 优先，manifest.description 兜底，二者皆缺 → 400
  const description = parsed.statement ?? manifest.description;
  if (!description || !description.trim()) {
    throw new BadRequestError(
      "缺少题面：zip 需包含 statement.md 或 manifest.description",
    );
  }

  // 4. 目标题目模式（编辑器支持包上传，tracking #55）：题号由**目标题目**决定，
  //    包内 `number` 不再参与匹配，也不再因非管理员而被拒；内容只写该题的草稿。
  let number: number | undefined;
  if (targetProblemId) {
    const identity = await loadProblemIdentity(targetProblemId);
    await assertProblemEditPermission(
      c,
      identity,
      actor.userId,
      actor.userRole,
    );
    if (manifest.type && manifest.type !== identity.type) {
      throw new BadRequestError("题包类型与目标题目不一致");
    }
    manifest.type = identity.type;
    number = identity.number;
    if (!identity.latest_version_id) {
      // 未发布题目 API 无法提交，也不存在编辑基线：target 模式必须有 draft revision。
      throw draftRevisionRequired();
    }
    if (targetExpectedRevision === undefined) throw draftRevisionRequired();
    const currentRevision = (await getProblemDraft(targetProblemId, identity))
      .revision;
    if (currentRevision !== Number(targetExpectedRevision)) {
      throw draftRevisionConflict(
        Number(targetExpectedRevision),
        currentRevision,
      );
    }
  }

  // 4.1 number 幂等键语义：admin 提供时按 (type, number) 匹配既有题目 → 更新、
  //     未命中 → 新建；非 admin 提供 number 直接拒绝（400），普通用户仅走创建路径。
  const admin = await isAdminActor(actor, c);
  if (!targetProblemId) {
    if (!admin && manifest.number !== undefined) {
      throw new BadRequestError(
        "仅管理员可指定 number（按 (type, number) 幂等更新既有题目）；普通用户导入时题号由系统自动分配",
      );
    }
    number = admin ? manifest.number : undefined;
  }

  // 4.5 客观题套卷：走独立导入路径（无评测包，事务性创建/更新 + 全量替换小题）
  if (manifest.is_objective) {
    const questions = validateObjectiveQuestions(parsed.questions);
    const paper = await importObjectivePaper(
      manifest,
      description,
      questions,
      number,
      actor,
      c,
      !!targetProblemId,
    );
    return { ...paper, warnings: parsed.warnings };
  }

  // 5. 剥离元数据，重建纯净评测包
  const strippedZip = stripMetadataEntries(file.data);

  // 5.1 编辑器初始代码模板：**随包上传、导入时持久化**（与题面 `description`
  //     同策略）。此前模板只在请求时按 `manifest.number + title` 去服务器本地
  //     `data/problems-src/` 里找，而生产镜像既没有私有题源、题包 manifest 又
  //     普遍不写 number（题号由导入自增分配）→ 线上所有题目的模板恒 404。
  //     改为从上传包内读取并落库后，运行期不再依赖部署目录，也不需要为读一个
  //     几 KB 的模板而下载整个支持包。
  const templateContent = extractImportedTemplate(manifest, parsed.entries);

  // 6. 分发：manifest.number 提供时按 (type, number) 业务键匹配（命中 → 更新；
  //    未命中 → 创建）；未提供 → 创建（number 自动分配）。id 一律由服务端生成，
  //    旧入口只在默认域匹配，域内数字题号由 DB 唯一约束保证。
  let result: ProblemResponseWithTags;
  if (number !== undefined) {
    const db = getDb();
    const byNumber = await db
      .select({
        id: problems.id,
        storageUrl: problems.support_package_storage_url,
        runtimeConfig: problems.runtime_config,
      })
      .from(problems)
      .where(
        and(
          eq(problems.number, number),
          or(
            eq(problems.domain_id, DEFAULT_DOMAIN_ID),
            isNull(problems.domain_id),
          ),
        ),
      )
      .limit(1);
    if (byNumber.length > 0) {
      result = await updateExisting(
        byNumber[0].id,
        byNumber[0].storageUrl,
        byNumber[0].runtimeConfig as RuntimeConfig | null,
        manifest,
        description,
        actor,
        c,
        strippedZip,
        templateContent,
      );
    } else {
      result = await createViaCrud(
        manifest,
        description,
        number,
        actor,
        c,
        strippedZip,
        templateContent,
      );
    }
  } else {
    // 创建路径（number 自动分配）
    result = await createViaCrud(
      manifest,
      description,
      number,
      actor,
      c,
      strippedZip,
      templateContent,
    );
  }

  // 7. 审计日志（仅 HTTP 路由场景；CLI 无 RequestContext，跳过）
  if (c) {
    await logAudit(
      "problems.imported",
      {
        action: "problems.imported",
        title: result.title,
        display_id: result.display_id,
        imported_with_id: false,
      },
      { type: "problem", id: result.id },
    );
  }

  return { ...result, warnings: parsed.warnings };
}

/**
 * 从上传包条目中取出编辑器初始代码模板内容。
 *
 * 返回值即 `problems.template_content` 的落库值：**空串表示"已核对、包内无模板"**
 * （解析时据此跳过回源读包，避免无模板的题目每次打开编辑器都下载整个支持包）。
 *
 * 语义：
 * - 包内没有模板文件 → `''`。**显式声明** `manifest.template` 却缺失时记 warning
 *   （出题人以为写了模板、实际没进包，此前正是这类静默失配让线上模板恒 404）。
 * - 条目超过 {@link MAX_TEMPLATE_BYTES} → `''` + warning（模板是骨架，不该是大文件）。
 */
function extractImportedTemplate(
  manifest: ProblemBundleManifest,
  entries: Record<string, Uint8Array>,
): string {
  const read = readBundleTemplate(entries, manifest.template);
  if (read.status === "ok") return read.content;

  if (read.status === "too_large") {
    logger.warn(
      "题目导入：模板文件超过大小上限，已忽略（模板应为作答骨架）",
      {
        template: manifest.template ?? DEFAULT_TEMPLATE_FILE,
        size: read.size,
        limit: MAX_TEMPLATE_BYTES,
      },
    );
    return "";
  }

  if (manifest.template !== undefined) {
    logger.warn("题目导入：manifest.template 声明的模板文件不在包内", {
      template: manifest.template,
    });
  }
  return "";
}

/**
 * 更新路径：替换评测包（尽力删除旧对象，失败不阻塞）+ 更新元数据。
 */
async function updateExisting(
  problemId: string,
  oldStorageUrl: string | null,
  oldRuntimeConfig: RuntimeConfig | null,
  manifest: ProblemBundleManifest,
  description: string,
  actor: BundleImportActor,
  c: Context | undefined,
  strippedZip: Uint8Array,
  templateContent: string,
): Promise<ProblemResponseWithTags> {
  // issue #207：先于 storage 操作执行敏感字段权限 + 资源上限校验——
  // 若在 storage 操作之后才失败（updateProblem 内部），旧评测包已被删除、
  // 新包已上传而 DB 未更新，造成评测包指向不存在的对象（评审 I4）。
  await assertSensitiveFieldPermissions(
    c,
    actor.userId,
    actor.userRole,
    manifest.runtime_config!,
    oldRuntimeConfig,
  );
  enforceResourceLimits(manifest.runtime_config!);
  if (manifest.llm) {
    assertLlmLimitsWithinDefault(manifest.llm);
  }

  const draft = await getProblemDraft(
    problemId,
    await loadProblemIdentity(problemId),
  );
  const rawRevision = c?.req.header("if-match");
  if (c && rawRevision === undefined) throw draftRevisionRequired();
  const expectedRevision = rawRevision === undefined
    ? draft.revision
    : Number(rawRevision.replace(/^"|"$/g, ""));
  // Handbook §2.5：物理上传之前先写上传预约（reserve → put → 登记 ready）。
  // 若先 put 再取登记行锁，并发删除会把刚写回的文件删掉，随后登记出
  // "ready 但物理缺失"的幽灵对象（2026-10-11 复审问题 1）。
  const { storageUrl } = await uploadStorageObjectWithReservation({
    key: buildPackageKey(`${problemId}/${crypto.randomUUID()}`),
    bytes: strippedZip,
    contentType: "application/zip",
  });
  try {
    const updated = await updateProblem(
      problemId,
      {
        title: manifest.title,
        samples: manifest.samples ?? [],
        description,
        expected_revision: expectedRevision,
        difficulty: manifest.difficulty,
        runtime_config: manifest.runtime_config!,
        judge_type: isOiRuntimeConfig(manifest.runtime_config) ? "oi" : "dual",
        submission_mode: manifest.submission_mode,
        artifact_max_size_mb: manifest.artifact_max_size_mb,
        llm: manifest.llm,
        support_package_storage_url: storageUrl,
        // 模板与题包同源：重新导入即用新包内的模板覆盖（包内无模板则清空，
        // 避免旧模板与新题包不一致）。
        template_content: templateContent,
        tag_ids: await resolveTagIds(manifest.tags),
      },
      actor.userId,
      actor.userRole,
      c,
      true, // import-bundle 是服务端生成 storage URL 的受控流程
    );
    // 旧包不能直删：历史版本仍引用它（重测要按版本取包），统一走引用守卫；
    // 引用存在时保留字节，只解绑草稿引用。
    if (oldStorageUrl && oldStorageUrl !== storageUrl) {
      try {
        const outcome = await deleteStorageObject(oldStorageUrl);
        if (outcome.outcome === "referenced") {
          logger.info("题目导入：旧评测包仍被历史版本引用，保留字节", {
            problem_id: problemId,
          });
        }
      } catch (err) {
        logger.warn("题目导入：删除旧评测包失败", {
          problem_id: problemId,
          err,
        });
      }
    }
    return updated;
  } catch (error) {
    if (storageUrl !== oldStorageUrl) {
      await deleteStorageObject(storageUrl).catch((cleanupError) =>
        logger.warn("导入回滚：新评测包清理失败", {
          problem_id: problemId,
          err: cleanupError,
        })
      );
    }
    throw error;
  }
}

/**
 * 客观题套卷导入路径。
 *
 * 与编程题导入的差异：
 * - 不剥离/上传评测包，support_package_storage_url 保持 NULL；
 * - 套卷行 + 小题全量替换在同一 DB 事务内完成；
 * - 不自动重测历史提交。
 */
async function importObjectivePaper(
  manifest: ProblemBundleManifest,
  description: string,
  questions: ObjectiveQuestionBundleInput[],
  number: number | undefined,
  actor: BundleImportActor,
  c?: Context,
  explicitTarget = false,
): Promise<ProblemResponseWithTags> {
  const type = manifest.type ?? "U";

  // number 权限（与编程题一致，防御性重复校验）
  if (
    !explicitTarget && !(await isAdminActor(actor, c)) && number !== undefined
  ) {
    throw new BadRequestError(
      "仅管理员可指定 number（按 (type, number) 幂等更新既有题目）；普通用户导入时题号由系统自动分配",
    );
  }

  // 类型权限（与 createViaCrud 一致）
  if (type === "P") {
    if (!(await isAdminActor(actor, c))) {
      throw new ForbiddenError("仅管理员可创建管理题");
    }
  } else if (c) {
    const canCreate = await checkPermission(c, "problem:create");
    if (!canCreate) {
      throw new ForbiddenError("无权创建题目");
    }
  } else if (actor.userRole !== "admin" && actor.userRole !== "user") {
    throw new ForbiddenError("无权创建题目");
  }

  const db = getDb();
  const tagIds = await resolveTagIds(manifest.tags);
  // 半写入防护：客观题禁止算法标签在写库前校验
  if (tagIds.length > 0) {
    await validateProblemTagIds(tagIds, true);
  }

  const now = new Date().toISOString();
  let oldStorageUrl: string | null = null;
  await ensureDefaultWorkspace();

  const outcome = await db.transaction(async (tx) => {
    let existingId: string | null = null;
    if (number !== undefined) {
      const rows = await tx
        .select({
          id: problems.id,
          storageUrl: problems.support_package_storage_url,
        })
        .from(problems)
        .where(
          and(
            eq(problems.number, number),
            or(
              eq(problems.domain_id, DEFAULT_DOMAIN_ID),
              isNull(problems.domain_id),
            ),
          ),
        )
        .limit(1);
      if (rows.length > 0) {
        existingId = rows[0].id;
        oldStorageUrl = rows[0].storageUrl;
      }
    }

    let problemId: string;
    let isNewProblem = false;
    if (existingId) {
      problemId = existingId;
      const identity = await loadProblemIdentity(problemId, tx);
      await assertProblemEditPermission(
        c,
        identity,
        actor.userId,
        actor.userRole,
      );
      // 题型不可变（Handbook §2.3）：编程题（AI/OI）导入客观题包必须冲突，
      // 而不是把题目行改成客观题、清空运行配置/模板后再另写草稿——即使发布被
      // 拒绝，身份行也已与版本内容不一致（公开投影被提前改写）。
      if (!identity.is_objective) {
        throw new AppError(
          "已存在的编程题不能通过导入客观题包改为客观题；跨题型转换请新建题目",
          409,
          "CONTENT_KIND_IMMUTABLE",
        );
      }
      await tx.select({ id: problems.id }).from(problems).where(
        eq(problems.id, problemId),
      ).for("update");
      await tx.update(problems).set({
        difficulty: manifest.difficulty ?? "medium",
        updated_at: now,
      }).where(eq(problems.id, problemId));
    } else {
      isNewProblem = true;
      problemId = crypto.randomUUID();
      const reservation = await prepareDomainProblemCreation(
        DEFAULT_DOMAIN_SLUG,
        actor.userId ?? ROOT_USER_ID,
        number,
        tx,
        true,
      );
      const [created] = await tx.insert(problems).values({
        id: problemId,
        title: manifest.title,
        samples: manifest.samples ?? [],
        description,
        difficulty: manifest.difficulty ?? "medium",
        runtime_config: null,
        judge_type: "dual",
        is_objective: true,
        visibility: type === "P" ? "public" : "private",
        number: reservation.number,
        domain_id: reservation.domain.id,
        owner_id: actor.userId ?? ROOT_USER_ID,
        type,
        created_at: now,
        updated_at: now,
      }).returning();
      await bindCreatedDomainProblem(
        created,
        reservation.domain.id,
        actor.userId ?? ROOT_USER_ID,
        reservation.used,
        tx,
      );
    }

    // 全量替换小题：**草稿是唯一事实源**（Handbook §6.4，旧 `objective_questions`
    // 表已在 0107 删除）。key 取包内显式 key 或新生成 UUID。
    const snapshots: ObjectiveQuestionSnapshot[] = [];
    for (const q of questions) {
      const options = q.type === "judge" ? judgeOptions() : (q.options ?? []);
      const key = q.key?.trim() || crypto.randomUUID();
      snapshots.push({
        key,
        sort_order: q.sort_order ?? snapshots.length,
        type: q.type as ObjectiveQuestionSnapshot["type"],
        prompt: q.prompt,
        options,
        answer: q.answer,
        explanation: q.explanation ?? "",
      });
    }

    const identity = await loadProblemIdentity(problemId, tx);
    const draft = await getProblemDraft(problemId, identity, tx);
    const rawRevision = c?.req.header("if-match");
    if (existingId && c && rawRevision === undefined) {
      throw draftRevisionRequired();
    }
    const expectedRevision = rawRevision === undefined
      ? draft.revision
      : Number(rawRevision.replace(/^"|"$/g, ""));
    await tx.delete(problemTags).where(eq(problemTags.problem_id, problemId));
    if (tagIds.length) {
      await tx.insert(problemTags).values(
        tagIds.map((tag_id) => ({ problem_id: problemId, tag_id })),
      );
    }
    const draftContent = {
      kind: "objective" as const,
      title: manifest.title,
      description,
      samples: manifest.samples ?? [],
      questions: snapshots,
    };
    await saveProblemDraftWithObjects(problemId, {
      content: draftContent,
      expectedRevision,
      actorId: actor.userId,
      context: c,
      objects: [],
    }, tx);
    // 公开投影只由**发布**更新（Handbook §2.2）：已发布题目导入只改草稿，
    // 题面/运行配置等投影保持不变，导入被拒绝或未发布时对外内容零变化。
    // 未发布题目除外——尚无版本可发布，投影是它唯一的读取来源，必须与草稿一致。
    if (isNewProblem) {
      await tx.update(problems).set({
        title: draftContent.title,
        description: draftContent.description,
        samples: draftContent.samples,
        runtime_config: null,
        template_content: null,
        judge_type: "dual",
        updated_at: now,
      }).where(eq(problems.id, problemId));
    }
    return { problemId, snapshots };
  });

  // 旧投影引用（仅未发布存量行会有）统一走引用守卫：历史版本/提交仍引用时保留字节。
  if (oldStorageUrl) {
    try {
      const outcome = await deleteStorageObject(oldStorageUrl);
      if (outcome.outcome === "referenced") {
        logger.info("客观题导入：旧投影支持包仍被引用，保留字节", {
          problem_id: outcome.references.total,
        });
      }
    } catch (err) {
      logger.warn("客观题导入：清理旧投影支持包失败", { err });
    }
  }

  return getProblem(outcome.problemId);
}

/**
 * 创建路径。
 *
 * 与 createProblem 对齐的校验（P 型权限、镜像白名单、number 分配）。
 * id 一律由服务端生成 UUID；(type, number) 由 DB 联合唯一约束保证唯一，
 * 并发冲突（23505）时自动分配重试。
 */
async function createViaCrud(
  manifest: ProblemBundleManifest,
  description: string,
  number: number | undefined,
  actor: BundleImportActor,
  c: Context | undefined,
  strippedZip: Uint8Array,
  templateContent: string,
): Promise<ProblemResponseWithTags> {
  const type = manifest.type ?? "U";

  // NOJ-102：创建权限按类型强制执行（与 createProblem 一致）。
  if (type === "P") {
    if (!(await isAdminActor(actor, c))) {
      throw new ForbiddenError("仅管理员可创建管理题");
    }
  } else if (c) {
    const canCreate = await checkPermission(c, "problem:create");
    if (!canCreate) {
      throw new ForbiddenError("无权创建题目");
    }
  } else if (actor.userRole !== "admin" && actor.userRole !== "user") {
    throw new ForbiddenError("无权创建题目");
  }

  // 双容器题目才需要镜像白名单；OI 题使用 worker 的受信固定镜像。
  if (!isOiRuntimeConfig(manifest.runtime_config)) {
    await validateJudgeImageWithKind(
      manifest.runtime_config!.evaluator.image,
      "evaluator",
    );
    await validateJudgeImageWithKind(
      manifest.runtime_config!.solution.image,
      "solution",
    );
  }

  // evaluator 联网权限与题目创建权限一致：普通用户导入创建 U 型题可开网；
  // P 型由上方类型检查保证仅 admin。安全提醒：联网 + 可控 evaluator.command
  // = 联网容器任意命令执行，题目包 manifest.runtime_config 由上传者完全可控。
  // issue #207：与 CRUD 创建路径一致的敏感字段权限检查 + 资源上限校验
  if (!isOiRuntimeConfig(manifest.runtime_config)) {
    await assertSensitiveFieldPermissions(
      c,
      actor.userId,
      actor.userRole,
      manifest.runtime_config!,
    );
    enforceResourceLimits(manifest.runtime_config!);
  }
  if (manifest.llm) {
    assertLlmLimitsWithinDefault(manifest.llm);
  }

  const db = getDb();
  const tagIds = await resolveTagIds(manifest.tags);

  const now = new Date().toISOString();
  const created = await createProblem(
    {
      title: manifest.title,
      samples: manifest.samples ?? [],
      description,
      difficulty: manifest.difficulty ?? "medium",
      runtime_config: manifest.runtime_config!,
      judge_type: isOiRuntimeConfig(manifest.runtime_config) ? "oi" : "dual",
      visibility: type === "P" ? "public" : "private",
      submission_mode: manifest.submission_mode ?? "code",
      artifact_max_size_mb: manifest.artifact_max_size_mb ?? null,
      llm: manifest.llm ?? null,
      number,
      type,
      tag_ids: tagIds,
    },
    actor.userId,
    actor.userRole,
    c,
  );
  const id = created.id;
  await db.update(problems).set({ template_content: templateContent }).where(
    eq(problems.id, id),
  );

  // 注册评测包并回填（先预约再物理上传，上传成功后登记 ready 并消费预约）
  const { storageUrl } = await uploadStorageObjectWithReservation({
    key: buildPackageKey(id),
    bytes: strippedZip,
    contentType: "application/zip",
  });
  await db
    .update(problems)
    .set({ support_package_storage_url: storageUrl, updated_at: now })
    .where(eq(problems.id, id));

  // 导入是内容写入者：创建路径直接插题目行，需补建共享草稿并把支持包绑定到
  // **草稿**引用，`--publish` 才有内容与文件可固定（Handbook §5.3 第 7 步）。
  await syncProblemDraftFromProjection(id, actor.userId);
  await replaceDraftObjectsForRole(id, "support_package", [{
    path: "package.zip",
    storage_url: storageUrl,
  }]);

  return getProblem(id);
}

/**
 * 供 CLI 使用的题面兜底：按 id 查询题目（无 id 时抛 NotFoundError）。
 * 仅导出给 scripts/noj.ts 复用，避免重复查询逻辑。
 */
export async function requireProblemById(id: string): Promise<void> {
  const db = getDb();
  const existing = await db
    .select({ id: problems.id })
    .from(problems)
    .where(eq(problems.id, id))
    .limit(1);
  if (existing.length === 0) {
    throw new NotFoundError(`题目不存在：${id}`);
  }
}

export { getProblem };
