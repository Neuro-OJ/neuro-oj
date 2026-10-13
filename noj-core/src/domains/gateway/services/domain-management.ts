import { eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import { domainLlmSettings } from "../../../shared/db/schema.ts";
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import {
  assertWorkspacePermission,
  loadWorkspace,
  workspaceAudit,
} from "../../workspace/index.ts";
import { DEFAULT_DOMAIN_ID } from "../../../shared/workspace/types.ts";
import { seedDomainLlmDefaults } from "./domain-default.ts";
import {
  createLlmProvider,
  getLlmProviderById,
  listLlmProviders,
  listLlmQuotas,
  LlmGatewayError,
  type LlmProviderInput,
  type LlmQuotaInput,
  type LlmUsageQuery,
  queryLlmUsage,
  updateLlmProvider,
  upsertLlmQuota,
} from "./llm.ts";

async function scoped<T>(
  slug: string,
  actorId: string,
  write: boolean,
  action:
    | "domain.llm_read"
    | "domain.llm_settings"
    | "domain.llm_provider"
    | "domain.llm_quota",
  operation: (domainId: string, tx: Executor) => Promise<T>,
) {
  return await getDb().transaction(async (tx) => {
    const workspace = await loadWorkspace(slug, actorId, {
      executor: tx,
      write,
      lock: write ? true : "share",
    });
    assertWorkspacePermission(workspace.context, "llm:manage");
    let result: T;
    try {
      result = await operation(workspace.domain.id, tx);
    } catch (error) {
      if (!(error instanceof LlmGatewayError)) throw error;
      if (error.status === 404) {
        throw new NotFoundError("工作空间 LLM 资源不存在");
      }
      if (error.status < 500) {
        throw new BadRequestError("LLM 配置请求无效", error.code);
      }
      throw new AppError("LLM Gateway 暂时不可用", 503, error.code);
    }
    if (write || workspace.platformAdmin) {
      await workspaceAudit(tx, actorId, workspace.domain.id, action);
    }
    return result;
  });
}

/** 当前使用域设置；新域返回空选择和 revision 0。 */
export function readDomainLlmSettings(slug: string, actorId: string) {
  return scoped(
    slug,
    actorId,
    false,
    "domain.llm_read",
    async (domainId, tx) => {
      if (domainId === DEFAULT_DOMAIN_ID) await seedDomainLlmDefaults(tx);
      const [settings] = await tx.select().from(domainLlmSettings).where(
        eq(domainLlmSettings.domain_id, domainId),
      );
      return settings ??
        {
          domain_id: domainId,
          provider_id: null,
          model: null,
          revision: 0,
          updated_at: null,
        };
    },
  );
}

/** 明确选择或关闭本域默认模型，版本冲突不覆盖已有选择。 */
export function saveDomainLlmSettings(
  slug: string,
  actorId: string,
  revision: number | null,
  input: { provider_id: string | null; model: string | null },
) {
  if (revision === null) {
    throw new AppError("需要 LLM 配置 revision", 428, "REVISION_REQUIRED");
  }
  if (!Number.isInteger(revision) || revision < 0) {
    throw new BadRequestError("revision 非法");
  }
  if (
    (input.provider_id === null) !== (input.model === null) ||
    input.provider_id !== null &&
      (typeof input.provider_id !== "string" || !input.provider_id.trim()) ||
    input.model !== null &&
      (typeof input.model !== "string" || !input.model.trim() ||
        input.model.length > 200)
  ) {
    throw new BadRequestError("Provider 与模型须同时设置或同时关闭");
  }
  return scoped(
    slug,
    actorId,
    true,
    "domain.llm_settings",
    async (domainId, tx) => {
      if (domainId === DEFAULT_DOMAIN_ID) await seedDomainLlmDefaults(tx);
      const [existing] = await tx.select().from(domainLlmSettings).where(
        eq(domainLlmSettings.domain_id, domainId),
      ).for("update");
      if ((existing?.revision ?? 0) !== revision) {
        throw new ConflictError(
          "LLM 配置已修改",
          "REVISION_CONFLICT",
        );
      }
      if (input.provider_id) {
        const provider = await getLlmProviderById(input.provider_id, domainId);
        if (
          provider.domain_id !== domainId || !provider.enabled
        ) throw new BadRequestError("Provider 不属于当前域或已停用");
      }
      const values = {
        domain_id: domainId,
        provider_id: input.provider_id?.trim() ?? null,
        model: input.model?.trim() ?? null,
        revision: revision + 1,
        updated_at: new Date().toISOString(),
      };
      const [saved] = existing
        ? await tx.update(domainLlmSettings).set(values).where(
          eq(domainLlmSettings.domain_id, domainId),
        ).returning()
        : await tx.insert(domainLlmSettings).values(values).returning();
      return saved;
    },
  );
}

/** 本域 Provider 列表，不列出其他域的名称、地址或掩码。 */
export function readDomainLlmProviders(slug: string, actorId: string) {
  return scoped(
    slug,
    actorId,
    false,
    "domain.llm_read",
    (domainId) => listLlmProviders(domainId),
  );
}

/** 本域新增 Provider，密钥由 Gateway 加密。 */
export function addDomainLlmProvider(
  slug: string,
  actorId: string,
  input: LlmProviderInput,
) {
  return scoped(
    slug,
    actorId,
    true,
    "domain.llm_provider",
    (domainId) => createLlmProvider(input, domainId),
  );
}

/** 本域更新或停用 Provider，历史引用不被删除。 */
export function editDomainLlmProvider(
  slug: string,
  actorId: string,
  id: string,
  input: Partial<LlmProviderInput>,
) {
  return scoped(
    slug,
    actorId,
    true,
    "domain.llm_provider",
    (domainId) => updateLlmProvider(id, input, domainId),
  );
}

/** 本域持久配额列表。 */
export function readDomainLlmQuotas(slug: string, actorId: string) {
  return scoped(
    slug,
    actorId,
    false,
    "domain.llm_read",
    (domainId) => listLlmQuotas(domainId),
  );
}

/** 域管理员只能配置域内配额；实例总量由平台治理入口维护。 */
export function saveDomainLlmQuota(
  slug: string,
  actorId: string,
  input: LlmQuotaInput,
) {
  if (input.scope_type === "global") {
    throw new ForbiddenError("实例总额度不能通过域管理入口修改");
  }
  return scoped(
    slug,
    actorId,
    true,
    "domain.llm_quota",
    (domainId) => upsertLlmQuota(input, domainId),
  );
}

/** 本域调用用量分页，Gateway 始终追加当前域条件。 */
export function readDomainLlmUsage(
  slug: string,
  actorId: string,
  query: LlmUsageQuery,
) {
  return scoped(
    slug,
    actorId,
    false,
    "domain.llm_read",
    (domainId) => queryLlmUsage(query, domainId),
  );
}
