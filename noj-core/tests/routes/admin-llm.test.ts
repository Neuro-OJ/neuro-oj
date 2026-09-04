import {
  assertEquals,
  assertInstanceOf,
  assertThrows,
} from "jsr:@std/assert@^1";
import {
  BadRequestError,
  NotFoundError,
  ServiceUnavailableError,
} from "../../src/shared/base/errors.ts";
import { LlmGatewayError } from "../../src/domains/gateway/services/llm.ts";
import { mapLlmError } from "../../src/domains/gateway/routes/admin-llm.ts";

Deno.test("admin-llm: gateway 404 映射为 NotFoundError", () => {
  const error = assertThrows(() =>
    mapLlmError(new LlmGatewayError(404, "provider_not_found"))
  );

  assertInstanceOf(error, NotFoundError);
  assertEquals(error.statusCode, 404);
  assertEquals(error.code, "NOT_FOUND");
});

Deno.test("admin-llm: gateway 400 保留业务错误码", () => {
  const error = assertThrows(() =>
    mapLlmError(new LlmGatewayError(400, "missing_required_fields"))
  );

  assertInstanceOf(error, BadRequestError);
  assertEquals(error.statusCode, 400);
  assertEquals(error.code, "missing_required_fields");
  assertEquals(error.message, "missing_required_fields");
});

Deno.test("admin-llm: gateway 5xx 映射为 ServiceUnavailableError", () => {
  const error = assertThrows(() =>
    mapLlmError(new LlmGatewayError(502, "upstream_error"))
  );

  assertInstanceOf(error, ServiceUnavailableError);
  assertEquals(error.statusCode, 503);
  assertEquals(error.code, "SERVICE_UNAVAILABLE");
});

Deno.test("admin-llm: 未知异常继续交给全局错误处理", () => {
  const original = new Error("unexpected route failure");
  const error = assertThrows(() => mapLlmError(original));

  assertEquals(error, original);
});
