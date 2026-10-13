import { eq } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import {
  domainLlmSettings,
  systemSettings,
} from "../../../shared/db/schema.ts";
import {
  type DomainLlmQuotaCaps,
  validateDomainLlmQuotaCaps,
} from "../../../shared/workspace/resource-policy.ts";
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
  operation: (
    domainId: string,
    tx: Executor,
    platformAdmin: boolean,
  ) => Promise<T>,
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
      result = await operation(
        workspace.domain.id,
        tx,
        workspace.platformAdmin,
      );
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
    async (domainId, tx, platformAdmin) => {
      const window = input.window_type ?? "day";
      if (window !== "day" && window !== "month") {
        throw new BadRequestError("配额窗口非法");
      }
      if (input.scope_type === "domain" && !platformAdmin) {
        const rows = (await listLlmQuotas(domainId)).filter((row) => {
          const quota = row as LlmQuotaInput;
          return quota.scope_type === "domain" &&
            (quota.scope_id ?? "") === "" &&
            (quota.window_type ?? "day") === window;
        }) as LlmQuotaInput[];
        // 比较本域窗口全部现有约束，另建 ID 不会解除较严格额度。
        for (const field of ["max_calls", "max_tokens", "max_cost"] as const) {
          const finite = rows.map((row) => row[field]).filter((
            value,
          ): value is number => typeof value === "number");
          const current = finite.length ? Math.min(...finite) : null;
          const requested = input[field] ?? null;
          if (current !== null && (requested === null || requested > current)) {
            throw new ForbiddenError(
              "域管理员只能降低当前域总额度",
              "DOMAIN_LLM_QUOTA_INCREASE_FORBIDDEN",
            );
          }
        }
      }
      const [setting] = await tx.select({ value: systemSettings.value }).from(
        systemSettings,
      )
        .where(eq(systemSettings.key, "domain_llm_quota_caps"));
      if (setting) {
        const text = JSON.parse(setting.value);
        const caps: DomainLlmQuotaCaps = JSON.parse(text);
        validateDomainLlmQuotaCaps(caps);
        for (const field of ["max_calls", "max_tokens", "max_cost"] as const) {
          const cap = caps[window][field];
          const requested = input[field] ?? null;
          if (cap !== null && (requested === null || requested > cap)) {
            throw new BadRequestError(
              "域 LLM 配额超过实例上限",
              "DOMAIN_LLM_QUOTA_CAP_EXCEEDED",
            );
          }
        }
      }
      return await upsertLlmQuota(input, domainId);
    },
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
    async (domainId) => {
      const rows = await queryLlmUsage(query, domainId);
      // LLM 管理不授予源题评测数据或比赛组织权限，域端只返回计量定位。
      const fields = [
        "id",
        "domain_id",
        "submission_id",
        "attempt_id",
        "problem_version_id",
        "problem_id",
        "user_id",
        "provider_id",
        "model",
        "prompt_tokens",
        "completion_tokens",
        "total_tokens",
        "cached_prompt_tokens",
        "billed_prompt_tokens",
        "billed_total_tokens",
        "estimated_cost",
        "latency_ms",
        "status",
        "error_code",
        "created_at",
      ] as const;
      return rows.map((row) =>
        Object.fromEntries(
          fields.map((
            field,
          ) => [field, (row as Record<string, unknown>)[field]]),
        )
      );
    },
  );
}
