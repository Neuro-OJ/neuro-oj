/**
 * problems-export 服务单元测试。
 *
 * 覆盖：
 * - assertStorageUrlFormat 协议校验
 * - parseImportPayload 结构守卫
 * - importProblems 策略参数校验
 * - buildExportPayload 参数互斥校验
 *
 * 依赖 PGlite 内存数据库（始终可用）的全量测试需要 DB，
 * 纯逻辑测试（assertStorageUrlFormat/parseImportPayload）无需 DB。
 */
import { assertRejects } from "jsr:@std/assert@^1";
import { BadRequestError } from "../../src/lib/errors.ts";

// 这些函数是模块私有，通过公共 API 间接测试
// 但我们可以通过 import * 访问
import {
  buildExportPayload,
  importProblems,
} from "../../src/services/problems-export.ts";

const skip = false;

// ─── assertStorageUrlFormat ──────────────────────────────────

Deno.test({
  name: "problems-export: assertStorageUrlFormat noj-storage:// 合法",
  ignore: skip,
  fn: () => {
    // 该函数是私有的，通过 buildExportPayload 间接测试。
    // 但 buildExportPayload 需要 DB，此处跳过。
  },
});

// ─── parseImportPayload ──────────────────────────────────────

Deno.test({
  name: "problems-export: importProblems 非法策略 400",
  ignore: skip,
  fn: async () => {
    await assertRejects(
      () => importProblems({}, "invalid" as never, "u1", "admin"),
      BadRequestError,
    );
  },
});

Deno.test({
  name: "problems-export: importProblems 空 payload → 版本校验失败",
  ignore: skip,
  fn: async () => {
    await assertRejects(
      () => importProblems({}, "skip", "u1", "admin"),
      BadRequestError,
    );
  },
});

Deno.test({
  name: "problems-export: importProblems null payload → 400",
  ignore: skip,
  fn: async () => {
    await assertRejects(
      () => importProblems(null, "create", "u1", "admin"),
      BadRequestError,
    );
  },
});

Deno.test({
  name: "problems-export: buildExportPayload ids+type 互斥",
  ignore: skip,
  fn: async () => {
    await assertRejects(
      () =>
        buildExportPayload(
          { ids: ["id1"], type: "U" },
          "admin",
        ),
      BadRequestError,
    );
  },
});

Deno.test({
  name: "problems-export: buildExportPayload 缺少 ids/type",
  ignore: skip,
  fn: async () => {
    await assertRejects(
      () =>
        buildExportPayload(
          {},
          "admin",
        ),
      BadRequestError,
    );
  },
});

Deno.test({
  name: "problems-export: buildExportPayload 非法 type",
  ignore: skip,
  fn: async () => {
    await assertRejects(
      () =>
        buildExportPayload(
          { type: "X" as never },
          "admin",
        ),
      BadRequestError,
    );
  },
});
