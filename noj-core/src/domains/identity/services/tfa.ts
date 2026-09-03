/**
 * TFA 业务服务层（issue #228）。
 *
 * 管理 TOTP 二次验证的启用/禁用/恢复码，并提供登录时的 TFA 校验入口。
 */
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "./../../../shared/db/connection.ts";
import { tfaRecoveryCodes, users } from "./../../../shared/db/schema.ts";
import {
  BadRequestError,
  UnauthorizedError,
} from "./../../../shared/base/errors.ts";
import { logAuthEvent } from "../../system/index.ts";
import {
  decryptTfaSecret,
  encryptTfaSecret,
  generateRecoveryCodes,
  generateTfaSecret,
  hashRecoveryCode,
  verifyTfaCode,
} from "./security/tfa.ts";

type Db = ReturnType<typeof getDb>;

/** 查询用户是否已启用 TFA。 */
export async function getTfaStatus(userId: string): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ tfa_enabled: users.tfa_enabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.tfa_enabled ?? false;
}

/**
 * 生成 TOTP secret 并加密存储（不启用）。
 * 已启用 TFA 时拒绝；未启用但已有旧 secret 时覆盖旧 secret。
 */
export async function setupTfa(
  userId: string,
  username: string,
  clientIp = "unknown",
): Promise<{ secret: string; otpauthUrl: string }> {
  const db = getDb();
  const rows = await db
    .select({
      id: users.id,
      username: users.username,
      tfa_enabled: users.tfa_enabled,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const user = rows[0];
  if (!user) {
    throw new UnauthorizedError("用户不存在");
  }
  if (user.tfa_enabled) {
    throw new BadRequestError("TFA 已启用，请先禁用");
  }

  const { secret, otpauthUrl } = generateTfaSecret(username || user.username);
  const encrypted = encryptTfaSecret(secret);
  await db
    .update(users)
    .set({
      tfa_secret_encrypted: encrypted,
      updated_at: new Date().toISOString(),
    })
    .where(eq(users.id, userId));

  await logAuthEvent(userId, clientIp, "auth.tfa_setup", { user_id: userId });
  return { secret, otpauthUrl };
}

/**
 * 使用 6 位 TOTP 验证码确认启用 TFA。
 * 成功时生成 10 个恢复码并返回明文（仅此一次）。
 */
export async function confirmTfa(
  userId: string,
  code: string,
  clientIp = "unknown",
): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: users.id,
      tfa_enabled: users.tfa_enabled,
      tfa_secret_encrypted: users.tfa_secret_encrypted,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const user = rows[0];
  if (!user) {
    throw new UnauthorizedError("用户不存在");
  }
  if (user.tfa_enabled) {
    throw new BadRequestError("TFA 已启用");
  }
  if (!user.tfa_secret_encrypted) {
    throw new BadRequestError("请先调用 TFA setup 生成密钥");
  }

  const secret = decryptTfaSecret(user.tfa_secret_encrypted);
  if (!verifyTfaCode(secret, code)) {
    throw new UnauthorizedError("验证码错误");
  }

  const recoveryCodes = generateRecoveryCodes();
  const now = new Date().toISOString();
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ tfa_enabled: true, updated_at: now })
      .where(eq(users.id, userId));
    for (const recoveryCode of recoveryCodes) {
      await tx.insert(tfaRecoveryCodes).values({
        id: crypto.randomUUID(),
        user_id: userId,
        code_hash: await hashRecoveryCode(recoveryCode),
        used_at: null,
        created_at: now,
      });
    }
  });

  await logAuthEvent(userId, clientIp, "auth.tfa_enabled", { user_id: userId });
  return recoveryCodes;
}

/**
 * 原子消费一个恢复码。
 * 返回 true 表示消费成功（该码此前未使用）。
 */
async function consumeRecoveryCode(
  db: Db,
  userId: string,
  code: string,
): Promise<boolean> {
  const codeHash = await hashRecoveryCode(code);
  const result = await db
    .update(tfaRecoveryCodes)
    .set({ used_at: new Date().toISOString() })
    .where(
      and(
        eq(tfaRecoveryCodes.user_id, userId),
        eq(tfaRecoveryCodes.code_hash, codeHash),
        isNull(tfaRecoveryCodes.used_at),
      ),
    )
    .returning({ id: tfaRecoveryCodes.id });
  return result.length > 0;
}

/**
 * 校验用户的 TFA 凭证（TOTP 或恢复码）。
 * 供登录流程使用；恢复码校验成功后立即消费。
 */
export async function verifyTfaCodeForUser(
  userId: string,
  code: string,
  clientIp = "unknown",
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({
      tfa_enabled: users.tfa_enabled,
      tfa_secret_encrypted: users.tfa_secret_encrypted,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const user = rows[0];
  if (!user?.tfa_enabled) {
    return false;
  }

  if (user.tfa_secret_encrypted) {
    const secret = decryptTfaSecret(user.tfa_secret_encrypted);
    if (verifyTfaCode(secret, code)) {
      return true;
    }
  }

  const consumed = await consumeRecoveryCode(db, userId, code);
  if (consumed) {
    await logAuthEvent(userId, clientIp, "auth.tfa_recovery_used", {
      user_id: userId,
    });
  }
  return consumed;
}

/**
 * 禁用 TFA。
 * 需要 TOTP 或恢复码确认；使用恢复码时该码会被消费。
 */
export async function disableTfa(
  userId: string,
  code: string,
  clientIp = "unknown",
): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({ tfa_enabled: users.tfa_enabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!rows[0]) {
    throw new UnauthorizedError("用户不存在");
  }
  if (!rows[0].tfa_enabled) {
    throw new BadRequestError("TFA 未启用");
  }
  if (!(await verifyTfaCodeForUser(userId, code, clientIp))) {
    throw new UnauthorizedError("验证码错误");
  }

  // 用户状态更新与恢复码删除放在同一事务，保证原子边界：
  // 任一步失败都会回滚，避免出现"已禁用但残留恢复码"或"仍启用但恢复码被清空"。
  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({
        tfa_enabled: false,
        tfa_secret_encrypted: null,
        updated_at: new Date().toISOString(),
      })
      .where(eq(users.id, userId));
    await tx
      .delete(tfaRecoveryCodes)
      .where(eq(tfaRecoveryCodes.user_id, userId));
  });

  await logAuthEvent(userId, clientIp, "auth.tfa_disabled", {
    user_id: userId,
  });
}

/**
 * 重新生成恢复码。
 * 需要 TOTP 或恢复码确认；成功后作废旧码并返回新码。
 */
export async function regenerateRecoveryCodes(
  userId: string,
  code: string,
  clientIp = "unknown",
): Promise<string[]> {
  const db = getDb();
  const rows = await db
    .select({ tfa_enabled: users.tfa_enabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!rows[0]) {
    throw new UnauthorizedError("用户不存在");
  }
  if (!rows[0].tfa_enabled) {
    throw new BadRequestError("TFA 未启用");
  }
  if (!(await verifyTfaCodeForUser(userId, code, clientIp))) {
    throw new UnauthorizedError("验证码错误");
  }

  const recoveryCodes = generateRecoveryCodes();
  const now = new Date().toISOString();
  // 作废旧码 + 批量插入新码放在同一事务：任一次插入失败都会整体回滚，
  // 避免留下"零个或不足 10 个有效恢复码"的中间状态。
  await db.transaction(async (tx) => {
    await tx
      .delete(tfaRecoveryCodes)
      .where(eq(tfaRecoveryCodes.user_id, userId));
    for (const recoveryCode of recoveryCodes) {
      await tx.insert(tfaRecoveryCodes).values({
        id: crypto.randomUUID(),
        user_id: userId,
        code_hash: await hashRecoveryCode(recoveryCode),
        used_at: null,
        created_at: now,
      });
    }
  });

  await logAuthEvent(userId, clientIp, "auth.tfa_recovery_regenerated", {
    user_id: userId,
  });
  return recoveryCodes;
}
