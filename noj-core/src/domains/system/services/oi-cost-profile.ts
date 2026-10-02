import { sql } from "drizzle-orm";
import { getDb } from "../../../shared/db/connection.ts";
import { contests } from "../../../shared/db/schema.ts";
import { BadRequestError, ConflictError } from "../../../shared/base/errors.ts";
import { getSetting, updateSetting } from "./system-settings.ts";
import {
  isValidOiCostProfile,
  type OiCostProfile,
} from "../../catalog/index.ts";

/** system_settings 中保存活动 OI 成本表的键。 */
export const OI_COST_PROFILE_SETTING_KEY = "oi_cost_profile_active";

/** 启用校准表必须满足的误差门槛。 */
export const OI_COST_PROFILE_THRESHOLDS = Object.freeze({
  p95RelativeError: 0.25,
  categoryMedianRelativeError: 0.2,
});

export interface OiCostProfileValidation {
  p95_relative_error: number;
  category_median_relative_error: number;
  holdout_samples: number;
  measurement_verified: boolean;
}

export interface ActivatableOiCostProfile extends OiCostProfile {
  validation: OiCostProfileValidation;
}

function profilePayload(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value.trim() === "") return null;
  try {
    return JSON.parse(value);
  } catch {
    throw new BadRequestError("活动 OI 成本表不是合法 JSON");
  }
}

/** 对对象键排序后序列化，作为成本表摘要的唯一输入。 */
export function canonicalProfileJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalProfileJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${
      Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalProfileJson(record[key])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/** 验证成本表结构、摘要和独立留出集质量。 */
export async function validateActivatableOiCostProfile(
  value: unknown,
): Promise<ActivatableOiCostProfile> {
  const payload = profilePayload(value);
  if (!isValidOiCostProfile(payload)) {
    throw new BadRequestError("OI 成本表结构或数值边界无效");
  }
  const profile = payload as ActivatableOiCostProfile;
  const validation = profile.validation;
  if (!validation || typeof validation !== "object") {
    throw new BadRequestError("OI 成本表缺少独立留出集验证报告");
  }
  if (
    !Number.isFinite(validation.p95_relative_error) ||
    validation.p95_relative_error < 0 ||
    validation.p95_relative_error >
      OI_COST_PROFILE_THRESHOLDS.p95RelativeError ||
    !Number.isFinite(validation.category_median_relative_error) ||
    validation.category_median_relative_error < 0 ||
    validation.category_median_relative_error >
      OI_COST_PROFILE_THRESHOLDS.categoryMedianRelativeError ||
    !Number.isSafeInteger(validation.holdout_samples) ||
    validation.holdout_samples < 1 ||
    validation.measurement_verified !== true
  ) {
    throw new BadRequestError(
      "OI 成本表未通过独立留出集 P95/类别中位误差或可信计量校验",
    );
  }
  const { hash, ...withoutHash } = profile;
  const expectedHash = await sha256Hex(canonicalProfileJson(withoutHash));
  if (hash !== expectedHash) {
    throw new BadRequestError("OI 成本表摘要与内容不匹配");
  }
  return profile;
}

/** 读取当前活动成本表；每次从共享 system settings 读取，不建立进程缓存。 */
export async function getActiveOiCostProfile(): Promise<OiCostProfile | null> {
  const setting = getSetting(OI_COST_PROFILE_SETTING_KEY);
  if (!setting || setting.value === "" || setting.value === null) return null;
  try {
    return await validateActivatableOiCostProfile(setting.value);
  } catch (error) {
    if (error instanceof BadRequestError) {
      throw new BadRequestError("活动 OI 成本表已损坏，请重新导入校准报告");
    }
    throw error;
  }
}

/** 活动竞赛期间冻结成本表，避免同一场比赛跨硬件口径。 */
async function assertOiCostProfileChangeAllowed(): Promise<void> {
  const db = getDb();
  const active = await db.select({ id: contests.id })
    .from(contests)
    .where(sql`CASE
      WHEN ${contests.start_time} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
       AND ${contests.end_time} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
       AND pg_input_is_valid(${contests.start_time}, 'timestamptz')
       AND pg_input_is_valid(${contests.end_time}, 'timestamptz')
      THEN ${contests.start_time}::timestamptz <= now()
       AND ${contests.end_time}::timestamptz > now()
      ELSE true
    END`)
    .limit(1);
  if (active.length > 0) {
    throw new ConflictError("比赛进行期间不能切换 OI WASM 成本表");
  }
}

/** 导入并启用已通过校验的成本表，写入审计可追踪的 runtime setting。 */
export async function activateOiCostProfile(
  value: unknown,
  actorId: string,
): Promise<ActivatableOiCostProfile> {
  const profile = await validateActivatableOiCostProfile(value);
  await assertOiCostProfileChangeAllowed();
  await updateSetting(
    OI_COST_PROFILE_SETTING_KEY,
    JSON.stringify(profile),
    actorId,
  );
  return profile;
}

/** 管理端查询活动成本表的脱敏摘要。 */
export async function getOiCostProfileStatus(): Promise<{
  active: boolean;
  profile: OiCostProfile | null;
}> {
  const profile = await getActiveOiCostProfile();
  return { active: profile !== null, profile };
}
