import { and, eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import { classroomMemberships, classrooms } from "../../../shared/db/schema.ts";
import {
  AppError,
  ForbiddenError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import type { AssistantCapability } from "../../../shared/education-types.ts";
import {
  assertDomainFeatureEnabled,
  loadWorkspace,
} from "../../workspace/index.ts";

/** 班级请求只从明确域路径解析身份，每次读取当前域角色。 */
export async function loadClassroom(
  slug: string,
  classroomId: string,
  actorId: string,
  options: {
    executor?: Executor;
    write?: boolean;
    historicalStudent?: boolean;
  } = {},
) {
  const executor = options.executor ?? getDb();
  const workspace = await loadWorkspace(slug, actorId, {
    executor,
    write: options.write,
    lock: options.write ? "share" : false,
  });
  const query = executor.select().from(classrooms).where(and(
    eq(classrooms.id, classroomId),
    eq(classrooms.domain_id, workspace.domain.id),
  ));
  const [classroom] = options.write ? await query.for("update") : await query;
  if (!classroom) throw new NotFoundError("班级不存在");
  const [membership] = await executor.select().from(classroomMemberships).where(
    and(
      eq(classroomMemberships.classroom_id, classroom.id),
      eq(classroomMemberships.user_id, actorId),
    ),
  );
  const managesDomain = workspace.platformAdmin ||
    workspace.context.domainPermissions.has("classroom:manage_any");
  const active = workspace.membership && membership?.status === "active" &&
    membership.role === "student";
  const historical = options.historicalStudent && workspace.membership &&
    membership?.role === "student";
  if (!managesDomain && !active && !historical) {
    throw new NotFoundError("班级不存在或不可访问");
  }
  if (options.write) {
    await assertDomainFeatureEnabled(workspace.domain, "classroom", {
      executor,
      disabledCode: "MODULE_DISABLED",
    });
    if (classroom.status !== "active") {
      throw new AppError(
        "班级已归档，只能读取历史",
        403,
        "CLASSROOM_READ_ONLY",
      );
    }
  }
  return {
    ...workspace,
    classroom,
    classMembership: active ? membership : null,
    capabilities: new Set<AssistantCapability>(),
    managesDomain,
  };
}

/** 教学管理能力统一来自域角色；旧班级任职不产生权限。 */
export function assertClassroomCapability(
  access: Awaited<ReturnType<typeof loadClassroom>>,
  capability: AssistantCapability,
) {
  void capability;
  if (access.managesDomain) return;
  throw new ForbiddenError("没有此项教学权限", "CLASSROOM_PERMISSION_DENIED");
}

/** 班级联系人设置不产生或转移教学权限。 */
export function assertClassroomCoach(
  access: Awaited<ReturnType<typeof loadClassroom>>,
) {
  if (!access.managesDomain) {
    throw new ForbiddenError(
      "仅教练或域管理员可执行",
      "CLASSROOM_PERMISSION_DENIED",
    );
  }
}

/** 写操作使用明确 revision，避免覆盖同时发生的成员及配置变更。 */
export function assertClassroomRevision(
  actual: number,
  expected: number | null,
) {
  if (expected === null || !Number.isSafeInteger(expected) || expected < 0) {
    throw new AppError("需要班级 revision", 428, "REVISION_REQUIRED");
  }
  if (actual !== expected) {
    throw new AppError("班级已变化，请重新读取", 409, "REVISION_CONFLICT");
  }
}
