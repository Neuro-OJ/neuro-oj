import { assertEquals, assertInstanceOf } from "jsr:@std/assert@^1";
import { AppError, ConflictError, UnauthorizedError, ValidationError } from "../../src/lib/errors.ts";

Deno.test("errors: AppError 基类携带 statusCode 和 message", () => {
  const err = new AppError("测试错误", 400);
  assertInstanceOf(err, Error);
  assertEquals(err.message, "测试错误");
  assertEquals(err.statusCode, 400);
  assertEquals(err.name, "AppError");
});

Deno.test("errors: ConflictError 返回 409", () => {
  const err = new ConflictError("资源已存在");
  assertInstanceOf(err, AppError);
  assertEquals(err.message, "资源已存在");
  assertEquals(err.statusCode, 409);
  assertEquals(err.name, "ConflictError");
});

Deno.test("errors: UnauthorizedError 返回 401", () => {
  const err = new UnauthorizedError("未授权");
  assertEquals(err.statusCode, 401);
  assertEquals(err.name, "UnauthorizedError");
});

Deno.test("errors: ValidationError 返回 400", () => {
  const err = new ValidationError("参数无效");
  assertEquals(err.statusCode, 400);
  assertEquals(err.name, "ValidationError");
});

Deno.test("errors: AppError 子类可通过 instanceof AppError 识别", () => {
  const err = new ConflictError("冲突");
  assertEquals(err instanceof AppError, true);
});
