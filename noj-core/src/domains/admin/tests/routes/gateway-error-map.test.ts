import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { mapLlmError } from "../../routes/gateway.ts";
import { LlmGatewayError } from "../../../../modules/platform/gateway/services/llm.ts";
import {
  AppError,
  BadRequestError,
  ConflictError,
} from "../../../../shared/base/errors.ts";

Deno.test("admin gateway: 出站校验拦截映射为可操作的中文提示（G-03）", () => {
  const err = assertThrows(
    () => mapLlmError(new LlmGatewayError(400, "provider_base_url_blocked")),
    BadRequestError,
  );
  assertEquals(err.message.includes("NOJ_LLM_UPSTREAM_ALLOWED_HOSTS"), true);
  assertEquals(err.code, "provider_base_url_blocked");
});

Deno.test("admin gateway: 远端版本冲突与缺少版本保持409及428", () => {
  const conflict = assertThrows(
    () => mapLlmError(new LlmGatewayError(409, "revision_conflict")),
    ConflictError,
  );
  assertEquals(conflict.code, "REVISION_CONFLICT");
  const required = assertThrows(
    () => mapLlmError(new LlmGatewayError(428, "revision_required")),
    AppError,
  );
  assertEquals(required.statusCode, 428);
  assertEquals(required.code, "REVISION_REQUIRED");
});

Deno.test("admin gateway: 其他 400 错误码仍原样透传", () => {
  const err = assertThrows(
    () => mapLlmError(new LlmGatewayError(400, "missing_required_fields")),
    BadRequestError,
  );
  assertEquals(err.code, "missing_required_fields");
});
