import { eq, inArray } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import type { Executor } from "../../../shared/db/executor.ts";
import { domains, systemSettings } from "../../../shared/db/schema.ts";
import {
  AppError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from "../../../shared/base/errors.ts";
import { logAudit } from "./audit-log.ts";
import {
  getSetting,
  notifySettingsChanged,
  refreshSettingsCache,
  updateSetting,
} from "./system-settings.ts";

const SECTIONS = {
  access: [
    "instance_access",
    "instance_registration_mode",
    "allow_domain_registration_invites",
    "default_domain_slug",
  ],
  creation: ["domain_creation_policy", "domain_creation_limit"],
  modules: ["instance_allowed_modules"],
  limits: ["domain_default_limits", "domain_limit_caps"],
  "llm-limits": ["domain_llm_quota_caps"],
} as const;

function sectionKeys(section: string): readonly string[] {
  if (!Object.hasOwn(SECTIONS, section)) {
    throw new NotFoundError("设置分组不存在");
  }
  return SECTIONS[section as keyof typeof SECTIONS];
}

/** 分组版本来自数据库事实；空值设置也参与版本，避免跨副本缓存决定并发结果。 */
export async function readInstanceSettings(
  section: string,
  executor: Executor = getDb(),
) {
  const keys = sectionKeys(section);
  const rows = await executor.select().from(systemSettings).where(
    inArray(systemSettings.key, [...keys]),
  );
  const values: Record<string, unknown> = {};
  const version = keys.map((key) => {
    const row = rows.find((item) => item.key === key);
    values[key] = row ? JSON.parse(row.value) : getSetting(key)!.value;
    return [key, values[key], row?.updated_at || null];
  });
  const hash = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(version)),
    ),
  );
  const revision = Array.from(
    hash,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return { values, revision };
}

/** 一个功能页的设置在同一事务内校验、锁定和保存，提交后统一重新加载配置。 */
export async function saveInstanceSettings(
  section: string,
  values: Record<string, unknown>,
  revision: string | undefined,
  actorId: string,
) {
  const keys = sectionKeys(section);
  if (!revision) {
    throw new AppError("请携带 If-Match 设置版本", 428, "REVISION_REQUIRED");
  }
  if (
    Object.keys(values).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(values, key))
  ) {
    throw new BadRequestError("须提交此分组的完整设置，不得包含其他设置项");
  }
  const expected = revision.replace(/^"|"$/g, "");
  const saved = await getDb().transaction(async (tx) => {
    // 缺省项尚未落库时先建立锁定行；空时间戳仍表示未修改的缺省值。
    await tx.insert(systemSettings).values(keys.map((key) => ({
      key,
      value: JSON.stringify(getSetting(key)!.value),
      updated_at: "",
    }))).onConflictDoNothing();
    await tx.select({ key: systemSettings.key }).from(systemSettings)
      .where(inArray(systemSettings.key, [...keys])).orderBy(systemSettings.key)
      .for("update");
    const previous = await readInstanceSettings(section, tx);
    if (previous.revision !== expected) {
      throw new ConflictError(
        "设置已被修改，请重新读取后再保存",
        "VERSION_CONFLICT",
      );
    }
    if (section === "access") {
      const [domain] = await tx.select({ status: domains.status }).from(domains)
        .where(eq(domains.slug, String(values.default_domain_slug)));
      if (!domain || domain.status !== "active") {
        throw new BadRequestError("默认进入域须为正常使用的已有域");
      }
    }
    for (const key of keys) await updateSetting(key, values[key], actorId, tx);
    return { previous, result: await readInstanceSettings(section, tx) };
  });
  await refreshSettingsCache();
  notifySettingsChanged();
  await logAudit("settings.update", {
    action: "settings.update",
    operation: "PATCH",
    key: section,
    from: saved.previous.values,
    to: saved.result.values,
  }, {
    type: "system_setting",
    id: section,
  });
  return saved.result;
}
