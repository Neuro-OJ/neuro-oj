import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { mapLlmError } from "../../routes/gateway.ts";
import { LlmGatewayError } from "../../../gateway/services/llm.ts";
import { BadRequestError } from "../../../../shared/base/errors.ts";

Deno.test("admin gateway: 出站校验拦截映射为可操作的中文提示（G-03）", () => {
  const err = assertThrows(
    () => mapLlmError(new LlmGatewayError(400, "provider_base_url_blocked")),
    BadRequestError,
  );
  assertEquals(err.message.includes("NOJ_LLM_UPSTREAM_ALLOWED_HOSTS"), true);
  assertEquals(err.code, "provider_base_url_blocked");
});

Deno.test("admin gateway: 其他 400 错误码仍原样透传", () => {
  const err = assertThrows(
    () => mapLlmError(new LlmGatewayError(400, "missing_required_fields")),
    BadRequestError,
  );
  assertEquals(err.code, "missing_required_fields");
});
