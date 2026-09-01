/**
 * 题目敏感字段 RBAC 守卫（issue #207）。
 *
 * 将 runtime_config 中的高危敏感字段抽离为独立 RBAC 权限项，并按管理员配置
 * 的全局上限约束资源限制字段：
 *
 * - SENSITIVE_FIELD_PERMISSIONS：敏感字段路径 → 权限项 静态映射。
 *   seed-rbac 已按 NOJ-062 从 default user 角色撤销这些权限；管理员可显式
 *   授权给特定角色，授权后不会被重启恢复覆盖。
 * - RESOURCE_LIMIT_SETTINGS：资源限制字段 → 全局上限设置项 key 映射。
 *   设置值 > 0 时启用上限，超限拒绝。
 *
 * 检查语义：请求中**显式设置**的字段才触发检查（值为 null/undefined 视为
 * 未设置——如 `evaluator.network: null` 语义为"无网"，不触发检查；PATCH
 * 部分更新不触及字段则放行）。三条写入路径（CRUD 创建 / CRUD 更新 / 题目包
 * 导入）共用本守卫，行为一致。
 *
 * CLI 场景（无 Hono Context）fail-closed：仅 root 用户（显式 userId 或
 * 缺省默认）与显式 userRole="admin" 放行，其余拒绝——与既有权限检查模式
 * （如 createProblem 的 `c ? assertPermission : userRole` 拒绝语义）一致。
 *
 * 未来新增敏感字段：在此文件扩展映射 + 在对应文档/测试中补充场景。
 */

import type { Context } from "hono";
import { AppError, ForbiddenError } from "../../lib/errors.ts";
import { checkPermission } from "../../lib/permissions.ts";
import { getSetting } from "../system-settings.ts";
import { logger } from "../../lib/logging.ts";
import { ROOT_USER_ID } from "../../lib/constants.ts";
import type { RuntimeConfig } from "../../types/index.ts";

/** 敏感字段路径 → RBAC 权限项（`<section>.<field>` 结构） */
export const SENSITIVE_FIELD_PERMISSIONS: Record<string, string> = {
  "evaluator.command": "problem:field_evaluator_command",
  "evaluator.network": "problem:field_evaluator_network",
};

/** 资源限制字段路径 → 全局上限设置项 key */
export const RESOURCE_LIMIT_SETTINGS: Record<string, string> = {
  "evaluator.time_limit_ms": "judge_max_evaluator_time_limit_ms",
  "evaluator.memory_limit_mb": "judge_max_evaluator_memory_limit_mb",
  "solution.call_timeout_ms": "judge_max_solution_call_timeout_ms",
  "solution.memory_limit_mb": "judge_max_solution_memory_limit_mb",
};

/** 已告警过的非数字上限 key（避免配置错误期间每次写入都刷屏日志） */
const warnedInvalidLimits = new Set<string>();

/**
 * 对请求中显式设置的敏感字段执行 RBAC 权限检查。
 *
 * 有 Hono Context 时走 checkPermission（admin:full_access 通配放行），
 * 无权限抛带 FORBIDDEN code 的 ForbiddenError（HTTP 403）。
 * CLI 场景（无 Context）fail-closed：仅 root（显式 userId 或缺省默认）与
 * 显式 userRole="admin" 放行，其余拒绝。
 *
 * @throws {ForbiddenError} 无对应权限（HTTP 403 / FORBIDDEN）
 */
export async function assertSensitiveFieldPermissions(
  c: Context | undefined,
  userId: string | undefined,
  userRole: string | undefined,
  runtimeConfig: RuntimeConfig,
): Promise<void> {
  if (!runtimeConfig || typeof runtimeConfig !== "object") return;
  const rc = runtimeConfig as unknown as Record<
    string,
    Record<string, unknown>
  >;

  for (
    const [path, permission] of Object.entries(SENSITIVE_FIELD_PERMISSIONS)
  ) {
    const [section, field] = path.split(".");
    const container = rc[section];
    // 显式设置即检查：字段存在且值非 null/undefined（null = 未设置，
    // 如 `network: null` 语义为无网，与 problem-runtime-config spec 一致）
    if (
      container && typeof container === "object" &&
      container[field] != null
    ) {
      if (c) {
        // 显式带 FORBIDDEN code（assertPermission 的 ForbiddenError 无 code）
        if (!(await checkPermission(c, permission))) {
          throw new ForbiddenError(
            `权限不足：设置敏感字段 ${path} 需要权限 ${permission}`,
            "FORBIDDEN",
          );
        }
      } else if (
        (userId ?? ROOT_USER_ID) !== ROOT_USER_ID && userRole !== "admin"
      ) {
        throw new ForbiddenError(
          `权限不足：设置敏感字段 ${path} 需要权限 ${permission}`,
          "FORBIDDEN",
        );
      }
    }
  }
}

/**
 * 对请求中的资源限制字段执行全局上限校验（settings-registry 的 judge_max_* 配置）。
 *
 * 上限配置为 0（默认）时不限制；> 0 且请求值超过上限时拒绝。
 * 必填字段由 validateRuntimeConfig 保证为 number；未显式设置的字段跳过。
 *
 * @throws {AppError} HTTP 400 / RESOURCE_LIMIT_EXCEEDED（含上限与实际值）
 */
export function enforceResourceLimits(
  runtimeConfig: RuntimeConfig,
): void {
  if (!runtimeConfig || typeof runtimeConfig !== "object") return;
  const rc = runtimeConfig as unknown as Record<
    string,
    Record<string, unknown>
  >;

  for (const [path, settingKey] of Object.entries(RESOURCE_LIMIT_SETTINGS)) {
    const [section, field] = path.split(".");
    const value = rc[section]?.[field];
    if (typeof value !== "number") continue; // 未显式设置或非法值（结构校验兜底）

    const setting = getSetting(settingKey);
    // env 兜底值可能为非数字（如 JUDGE_MAX_*=abc 经 parseInt 失败回落字符串）：
    // 此时视为未配置（0），但显式告警便于运维发现配置错误（每 key 仅告警一次）
    if (setting && typeof setting.value !== "number") {
      if (!warnedInvalidLimits.has(settingKey)) {
        warnedInvalidLimits.add(settingKey);
        logger.warn(
          `资源上限配置 ${settingKey} 的值非数字（${
            String(setting.value)
          }），按不限制处理`,
        );
      }
    }
    const limit = typeof setting?.value === "number" ? setting.value : 0;
    if (limit > 0 && value > limit) {
      throw new AppError(
        `资源限制超限：${path}（${value}）超过管理员配置上限（${limit}）`,
        400,
        "RESOURCE_LIMIT_EXCEEDED",
        { field: path, value, limit },
      );
    }
  }
}
