/**
 * problems 应用编排入口。
 *
 * 这里是 HTTP/CLI 与 problems 本地实现之间的唯一写用例边界：操作者必须
 * 是已经由 access 解析出的 UserActor，路由不得把 Hono Context、role 字符串
 * 或空值继续传入业务。跨模块的删除/发布后续副作用在这里显式登记，不能
 * 通过业务函数里的可选 callback 悄悄跳过。
 */
import type { DraftObjectRef } from "../problems/services/versioning/draft.ts";
import type { ProblemDraftContent } from "../problems/types/problem-content.ts";
import {
  assertProblemEditPermissionForActor,
  createDomainProblemForActor,
  createProblemForActor,
  deleteProblemOwnedRowsTx,
  finalizeDeletedProblem,
  prepareProblemDeletionTx,
  updateProblemForActor,
} from "../problems/services/problems/problems-crud.ts";
import { deleteProblemEvaluationRowsTx } from "../evaluations/contracts/problem-deletion.ts";
import {
  importDomainProblemForActor,
  setDomainProblemBindingPolicyForActorTx,
  setDomainProblemBindingStateForActor,
} from "../problems/services/workspace/problem-bindings.ts";
import {
  createDraftQuestion,
  deleteDraftQuestion,
  type ObjectiveQuestionInput,
  updateDraftQuestion,
} from "../problems/services/objective/versioning/objective-drafts.ts";
import {
  assertObjectivePaper,
  assertPaperManageableForActor,
  getPaperOrThrow,
} from "../problems/services/objective/objective-questions.ts";
import {
  loadProblemIdentity,
  type ProblemDraftView,
  saveProblemDraft,
} from "../problems/services/versioning/draft.ts";
import {
  publishDomainProblemVersion,
  saveDomainProblemDraft,
} from "../problems/services/workspace/problem-edit.ts";
import { importDomainProblemBundle } from "../problems/services/workspace/problem-bundle-import.ts";
import { importDomainProblemDraftBundle } from "../problems/services/workspace/problem-bundle-edit.ts";
import { loadEditableDomainProblem } from "../problems/services/workspace/problem-edit.ts";
import { setDomainProblemSharing } from "../problems/services/workspace/problem-sharing.ts";
import {
  addTrainingProblem,
  createTraining,
  deleteTraining,
  removeTrainingProblem,
  reorderTrainingProblems,
  updateTraining,
} from "../problems/services/trainings.ts";
import {
  createTag,
  deleteTag,
  mergeTags,
  updateTag,
} from "../problems/services/tags.ts";
import {
  deleteDomainTraining,
  type DomainTrainingInput,
  saveDomainTraining,
} from "../problems/services/workspace/trainings.ts";
import {
  importDomainTraining,
  setDomainTrainingSharing,
} from "../problems/services/workspace/training-sharing.ts";
import {
  saveOiDraft,
  type SaveOiDraftResult,
} from "../problems/services/versioning/oi-draft.ts";
import type { ObjectiveQuestionSnapshot } from "../problems/types/problem-content.ts";
import { publishProblemVersion } from "../problems/services/versioning/publish.ts";
import {
  importProblemBundleForActor,
  publishImportedProblemForActor,
} from "../problems/services/problems/problem-bundle.ts";
import {
  deleteSupportPackageForActorTx,
  finalizeDeletedSupportPackage,
} from "../problems/services/support-package.ts";
import type {
  CreateProblemInput,
  ProblemResponseWithTags,
  UpdateProblemInput,
} from "../problems/types/problems.ts";
import type { EffectiveVersionPolicy } from "../../shared/versioning/types.ts";
import type { DbTx } from "../../shared/db/executor.ts";
import type { UserActor } from "../access/contracts/actor.ts";
import { getDb } from "../../shared/db/connection.ts";
import {
  bumpProjectionRevision,
  globalScopeKey,
  problemScopeKey,
  recomputeProblemBindingProjections,
} from "../evaluations/services/versioning/projection.ts";

export interface CreateProblemCommandOptions {
  readonly allowServerDerivedFields: boolean;
  readonly workspaceSlug?: string;
  readonly initialDraft?: {
    readonly content: ProblemDraftContent;
    readonly objects: DraftObjectRef[];
  };
}

export interface UpdateProblemCommandOptions {
  readonly allowServerDerivedFields: boolean;
  readonly expectedUpdatedAt?: string;
}

async function assertProblemCommandWritable(
  actor: UserActor,
  problemId: string,
): Promise<void> {
  const identity = await loadProblemIdentity(problemId);
  await assertProblemEditPermissionForActor(identity, actor);
}

/** 创建题目；HTTP 写入必须经过这个显式 UserActor 入口。 */
export function createProblemCommand(
  actor: UserActor,
  input: CreateProblemInput,
  options: CreateProblemCommandOptions,
): Promise<ProblemResponseWithTags> {
  return createProblemForActor(actor, input, options);
}

/** 在指定工作空间创建源题。 */
export function createDomainProblemCommand(
  actor: UserActor,
  slug: string,
  input: CreateProblemInput,
  options: CreateProblemCommandOptions,
) {
  return createDomainProblemForActor(actor, slug, input, options);
}

/** 更新题目；旧 userRole/Context 不得越过此边界。 */
export function updateProblemCommand(
  actor: UserActor,
  problemId: string,
  input: UpdateProblemInput,
  options: UpdateProblemCommandOptions,
): Promise<ProblemResponseWithTags> {
  return (async () => {
    await assertProblemCommandWritable(actor, problemId);
    return updateProblemForActor(actor, problemId, input, options);
  })();
}

/** 删除题目，并在同一 DbTx 内登记 evaluations 投影失效。 */
export function deleteProblemCommand(
  actor: UserActor,
  problemId: string,
): Promise<void> {
  return (async () => {
    const deleted = await getDb().transaction(async (tx) => {
      // 唯一外层事务，顺序固定：先完成 problems 的授权/锁/保留性检查，
      // 再由 evaluations 清理评测行（self_tests 外键依赖绑定行），
      // 最后删 problems 拥有行并登记投影 revision；任一步失败全部回滚。
      const result = await prepareProblemDeletionTx(
        problemId,
        actor.userId,
        tx,
      );
      await deleteProblemEvaluationRowsTx(tx, problemId);
      await deleteProblemOwnedRowsTx(problemId, result.problem.domain_id, tx);
      await bumpProjectionRevision(tx, globalScopeKey());
      await bumpProjectionRevision(tx, problemScopeKey(problemId));
      return result;
    });
    await finalizeDeletedProblem(problemId, deleted);
  })();
}

/** 删除题目支持包；草稿 revision 与 UserActor 都由应用命令显式绑定。 */
export function deleteSupportPackageCommand(
  actor: UserActor,
  problemId: string,
  expectedRevision: number,
): Promise<void> {
  return (async () => {
    const removed = await getDb().transaction((tx) =>
      deleteSupportPackageForActorTx(problemId, actor, expectedRevision, tx)
    );
    await finalizeDeletedSupportPackage(problemId, removed);
  })();
}

export interface PublishProblemVersionCommandInput {
  readonly expectedRevision: number | null | undefined;
  readonly changeNote?: string;
}

/** 发布不可变题目版本；授权身份只来自 UserActor。 */
export function publishProblemVersionCommand(
  actor: UserActor,
  problemId: string,
  input: PublishProblemVersionCommandInput,
) {
  return (async () => {
    await assertProblemCommandWritable(actor, problemId);
    return publishProblemVersion(problemId, {
      expectedRevision: input.expectedRevision,
      changeNote: input.changeNote,
      actor,
    });
  })();
}

/** 题包导入流程显式采用同一 UserActor；CLI 应使用独立 bootstrap 命令。 */
export function publishImportedProblemCommand(
  actor: UserActor,
  problemId: string,
  changeNote: string,
) {
  return publishImportedProblemForActor(actor, problemId, changeNote);
}

/** 主题库题包导入；目标题和按题号更新都必须显式携带 revision。 */
export function importProblemBundleCommand(
  actor: UserActor,
  file: { name: string; data: Uint8Array },
  expectedRevision?: number | "current",
  target?: { problemId: string; expectedRevision?: number | null },
) {
  return importProblemBundleForActor(file, actor, expectedRevision, target);
}

export function importDomainProblemCommand(
  actor: UserActor,
  slug: string,
  sourceReference: string,
) {
  return importDomainProblemForActor(slug, sourceReference, actor);
}

export function setDomainProblemBindingPolicyCommand(
  actor: UserActor,
  slug: string,
  reference: string,
  expectedRevision: number | null,
  policy: EffectiveVersionPolicy,
  reason: string,
) {
  return getDb().transaction((tx) =>
    setDomainProblemBindingPolicyCommandTx(
      actor,
      slug,
      reference,
      expectedRevision,
      policy,
      reason,
      tx,
    )
  );
}

/**
 * 在调用方已经开启的唯一外层事务中切换题库策略并重算评测投影。
 * `tx` 是必填参数，避免跨模块完整性依赖可省略 callback。
 */
export async function setDomainProblemBindingPolicyCommandTx(
  actor: UserActor,
  slug: string,
  reference: string,
  expectedRevision: number | null,
  policy: EffectiveVersionPolicy,
  reason: string,
  tx: DbTx,
) {
  const updated = await setDomainProblemBindingPolicyForActorTx(
    actor,
    slug,
    reference,
    expectedRevision,
    policy,
    reason,
    tx,
  );
  await recomputeProblemBindingProjections(tx, updated);
  return updated;
}

export function setDomainProblemBindingStateCommand(
  actor: UserActor,
  slug: string,
  reference: string,
  expectedRevision: number | null,
  input: {
    disabled: boolean;
    visibility?: "public" | "members";
    reason: string;
  },
) {
  return setDomainProblemBindingStateForActor(
    actor,
    slug,
    reference,
    expectedRevision,
    input,
  );
}

/** 修改题目跨域共享政策；共享授权必须绑定当前 UserActor。 */
export function setDomainProblemSharingCommand(
  actor: UserActor,
  slug: string,
  reference: string,
  input: Parameters<typeof setDomainProblemSharing>[2] extends string
    ? Parameters<typeof setDomainProblemSharing>[3]
    : never,
) {
  return setDomainProblemSharing(slug, reference, actor.userId, input);
}

/** 默认域题单写用例统一由 UserActor 进入。 */
export function createTrainingCommand(
  actor: UserActor,
  input: Parameters<typeof createTraining>[0],
) {
  return createTraining(input, actor.userId);
}

export function updateTrainingCommand(
  actor: UserActor,
  id: string,
  input: Parameters<typeof updateTraining>[1],
) {
  return updateTraining(id, input, actor.userId);
}

export function deleteTrainingCommand(actor: UserActor, id: string) {
  return deleteTraining(id, actor.userId);
}

export function deleteDomainTrainingCommand(
  actor: UserActor,
  slug: string,
  id: string,
) {
  return deleteDomainTraining(slug, actor.userId, id);
}

export function addTrainingProblemCommand(
  actor: UserActor,
  trainingId: string,
  problemId: string,
  position?: number,
) {
  return addTrainingProblem(trainingId, problemId, position, actor.userId);
}

export function reorderTrainingProblemsCommand(
  actor: UserActor,
  trainingId: string,
  problems: Parameters<typeof reorderTrainingProblems>[1],
) {
  return reorderTrainingProblems(trainingId, problems, actor.userId);
}

export function removeTrainingProblemCommand(
  actor: UserActor,
  trainingId: string,
  problemId: string,
) {
  return removeTrainingProblem(trainingId, problemId, actor.userId);
}

/** 域题单的创建/更新在同一 application 入口绑定身份。 */
export function saveDomainTrainingCommand(
  actor: UserActor,
  slug: string,
  input: DomainTrainingInput,
  target?: Parameters<typeof saveDomainTraining>[3],
) {
  return saveDomainTraining(slug, actor.userId, input, target);
}

export function setDomainTrainingSharingCommand(
  actor: UserActor,
  slug: string,
  reference: string,
  input: Parameters<typeof setDomainTrainingSharing>[3],
) {
  return setDomainTrainingSharing(slug, reference, actor.userId, input);
}

export function importDomainTrainingCommand(
  actor: UserActor,
  slug: string,
  trainingId: string,
) {
  return importDomainTraining(slug, trainingId, actor.userId);
}

/** 标签管理命令保留显式操作者；审计观测仍由 HTTP composition 注入。 */
export function createTagCommand(
  _actor: UserActor,
  input: Parameters<typeof createTag>[0],
) {
  return createTag(input);
}

export function updateTagCommand(
  _actor: UserActor,
  id: string,
  input: Parameters<typeof updateTag>[1],
) {
  return updateTag(id, input);
}

export function deleteTagCommand(_actor: UserActor, id: string) {
  return deleteTag(id);
}

export function mergeTagsCommand(
  _actor: UserActor,
  sourceId: string,
  targetId: string,
) {
  return mergeTags(sourceId, targetId);
}

/** 保存共享草稿；HTTP 适配层只负责解析 If-Match，业务只接收 UserActor。 */
export function saveProblemDraftCommand(
  actor: UserActor,
  problemId: string,
  input: {
    readonly content: ProblemDraftContent;
    readonly expectedRevision: number;
  },
): Promise<ProblemDraftView> {
  return (async () => {
    await assertProblemCommandWritable(actor, problemId);
    return saveProblemDraft(problemId, {
      content: input.content,
      expectedRevision: input.expectedRevision,
      actorId: actor.userId,
      fromClient: true,
    });
  })();
}

/** 保存域源题草稿；域授权、revision 与内容写入由本地用例统一编排。 */
export function saveDomainProblemDraftCommand(
  actor: UserActor,
  slug: string,
  reference: string,
  content: ProblemDraftContent,
  expectedRevision: number,
): ReturnType<typeof saveDomainProblemDraft> {
  return saveDomainProblemDraft(
    slug,
    reference,
    actor,
    content,
    expectedRevision,
  );
}

/** 发布域源题版本；HTTP 层不把 Hono Context 传入 problems 业务。 */
export function publishDomainProblemVersionCommand(
  actor: UserActor,
  slug: string,
  reference: string,
  expectedRevision: number,
  changeNote: string,
): ReturnType<typeof publishDomainProblemVersion> {
  return publishDomainProblemVersion(
    slug,
    reference,
    actor,
    expectedRevision,
    changeNote,
  );
}

/** 导入新域题或按题号替换草稿；用户身份必须显式来自 UserActor。 */
export function importDomainProblemBundleCommand(
  actor: UserActor,
  slug: string,
  bytes: Uint8Array,
  expectedRevision?: number | "current",
) {
  return importDomainProblemBundle(
    slug,
    actor,
    bytes,
    expectedRevision,
  );
}

/** 替换已有域源题草稿题包；应用入口总是提供显式用户身份。 */
export function importDomainProblemDraftBundleCommand(
  actor: UserActor,
  slug: string,
  reference: string,
  bytes: Uint8Array,
  expectedRevision: number,
) {
  return importDomainProblemDraftBundle(
    slug,
    reference,
    actor,
    bytes,
    expectedRevision,
  );
}

/** OI 文件与配置必须由应用入口绑定同一 UserActor。 */
export function saveOiDraftCommand(
  actor: UserActor,
  problemId: string,
  input: Omit<Parameters<typeof saveOiDraft>[1], "actorId" | "authorize">,
  entries?: Record<string, Uint8Array>,
): Promise<SaveOiDraftResult> {
  return saveOiDraft(
    problemId,
    {
      ...input,
      actorId: actor.userId,
    },
    entries,
  );
}

/**
 * 域 OI 编辑的授权复核必须和草稿事务一起执行；调用方不能省略 callback，
 * 也不能把 Hono Context 传入业务层。
 */
export function saveDomainOiDraftCommand(
  actor: UserActor,
  slug: string,
  reference: string,
  problemId: string,
  input: Omit<Parameters<typeof saveOiDraft>[1], "actorId" | "authorize">,
  entries?: Record<string, Uint8Array>,
): Promise<SaveOiDraftResult> {
  return saveOiDraft(
    problemId,
    {
      ...input,
      actorId: actor.userId,
      authorize: async (tx) => {
        await loadEditableDomainProblem(slug, reference, actor, {
          executor: tx,
          write: true,
        });
      },
    },
    entries,
  );
}

/** 创建客观题小题；题目内容归 problems，判题执行不在此命令中。 */
export function createObjectiveQuestionCommand(
  actor: UserActor,
  problemId: string,
  input: ObjectiveQuestionInput,
  expectedRevision: number,
): Promise<ObjectiveQuestionSnapshot> {
  return createObjectiveQuestionCommandChecked(
    actor,
    problemId,
    input,
    expectedRevision,
  );
}

async function assertObjectiveQuestionWrite(
  actor: UserActor,
  problemId: string,
): Promise<void> {
  const paper = await getPaperOrThrow(problemId);
  assertObjectivePaper(paper);
  await assertPaperManageableForActor(paper, actor);
}

async function createObjectiveQuestionCommandChecked(
  actor: UserActor,
  problemId: string,
  input: ObjectiveQuestionInput,
  expectedRevision: number,
): Promise<ObjectiveQuestionSnapshot> {
  await assertObjectiveQuestionWrite(actor, problemId);
  return createDraftQuestion(
    problemId,
    input,
    expectedRevision,
    actor.userId,
  );
}

/** 更新客观题小题；答案与解析仍只写共享草稿。 */
export function updateObjectiveQuestionCommand(
  actor: UserActor,
  problemId: string,
  key: string,
  input: Partial<ObjectiveQuestionInput>,
  expectedRevision: number,
): Promise<ObjectiveQuestionSnapshot> {
  return (async () => {
    await assertObjectiveQuestionWrite(actor, problemId);
    return updateDraftQuestion(
      problemId,
      key,
      input,
      expectedRevision,
      actor.userId,
    );
  })();
}

/** 删除客观题小题；删除也必须携带草稿 revision。 */
export function deleteObjectiveQuestionCommand(
  actor: UserActor,
  problemId: string,
  key: string,
  expectedRevision: number,
): Promise<void> {
  return (async () => {
    await assertObjectiveQuestionWrite(actor, problemId);
    await deleteDraftQuestion(problemId, key, expectedRevision, actor.userId);
  })();
}
