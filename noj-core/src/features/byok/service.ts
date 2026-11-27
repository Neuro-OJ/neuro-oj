/**
 * 用户自带模型（BYOK）服务：薄封装 gateway 客户端并把网关错误码映射为业务错误。
 *
 * Key 只经过 core 内存转发到 gateway 加密保存，core 不落库、不回显明文。
 */
import {
  deleteUserLlmProvider,
  getUserLlmProvider,
  LlmGatewayError,
  saveUserLlmProvider,
  testUserLlmProvider,
  type UserLlmProviderInput,
  type UserLlmProviderView,
} from "../../modules/platform/index.ts";
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../shared/base/errors.ts";

import type {
  ByokState,
  ByokTestResult,
} from "../../shared/api-contracts/features.ts";
export type { ByokState, ByokTestResult };

/** 连通性测试会真实调用上游（用户付费），按账号限流。 */
const TEST_FAILURES: Record<string, string> = {
  provider_auth_failed: "上游鉴权失败：API Key 无效，或该 Key 无权访问此模型",
  provider_rate_limited: "上游限流（429）：请稍后重试，或检查账户额度",
  provider_unavailable: "无法连接上游：网络不通或 10 秒内无响应",
  provider_error: "上游返回错误：请检查 Base URL 与模型名称是否正确",
};

function mapGatewayError(error: unknown): never {
  if (!(error instanceof LlmGatewayError)) throw error;
  if (error.status === 409) {
    throw new ConflictError(
      "自带模型已被修改，请刷新后重试",
      "REVISION_CONFLICT",
    );
  }
  if (error.status === 404) {
    throw new NotFoundError("尚未配置自带模型");
  }
  if (error.code === "byok_disabled") {
    throw new BadRequestError(
      "本实例未开启自带模型（BYOK）",
      "BYOK_UNAVAILABLE",
    );
  }
  if (error.code === "provider_base_url_blocked") {
    throw new BadRequestError(
      "Base URL 不被允许：必须是 https 且主机在管理员允许的列表中",
      "BYOK_BASE_URL_BLOCKED",
    );
  }
  if (error.code === "provider_invalid") {
    throw new BadRequestError(
      "Base URL、模型与 API Key 不能为空，且长度不能过长",
      "BYOK_INVALID",
    );
  }
  if (error.status >= 500) {
    throw new ServiceUnavailableError("模型服务暂时不可用");
  }
  throw new BadRequestError(error.code, error.code);
}

/** 读取本人 BYOK 状态。 */
export async function readByok(userId: string): Promise<ByokState> {
  try {
    const result = await getUserLlmProvider(userId);
    return {
      enabled: result.enabled,
      allowed_hosts: result.allowed_hosts,
      provider: result.data,
    };
  } catch (error) {
    mapGatewayError(error);
  }
}

/** 校验请求体并只保留白名单字段。 */
export function parseByokInput(body: unknown): UserLlmProviderInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestError("请求体必须是对象");
  }
  const raw = body as Record<string, unknown>;
  const input: UserLlmProviderInput = {};
  for (const key of ["base_url", "model", "api_key"] as const) {
    const value = raw[key];
    if (value === undefined || value === null || value === "") continue;
    if (typeof value !== "string") {
      throw new BadRequestError(`${key} 必须是字符串`);
    }
    input[key] = value.trim();
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") {
      throw new BadRequestError("enabled 必须是布尔值");
    }
    input.enabled = raw.enabled;
  }
  return input;
}

/** 创建（revision=0）或更新本人自带模型。 */
export async function saveByok(
  userId: string,
  input: UserLlmProviderInput,
  revision: number,
): Promise<UserLlmProviderView> {
  try {
    return await saveUserLlmProvider(userId, input, revision);
  } catch (error) {
    mapGatewayError(error);
  }
}

/** 删除本人自带模型（含加密 Key）。 */
export async function removeByok(userId: string): Promise<void> {
  try {
    await deleteUserLlmProvider(userId);
  } catch (error) {
    mapGatewayError(error);
  }
}

/** 用已保存的 Key 发一次最小请求测试连通性。 */
export async function testByok(userId: string): Promise<ByokTestResult> {
  try {
    await testUserLlmProvider(userId);
    return { status: "ok" };
  } catch (error) {
    if (error instanceof LlmGatewayError && TEST_FAILURES[error.code]) {
      return {
        status: "failed",
        code: error.code,
        message: TEST_FAILURES[error.code],
      };
    }
    mapGatewayError(error);
  }
}
