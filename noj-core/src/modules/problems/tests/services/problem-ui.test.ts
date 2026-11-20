/**
 * 界面题 `ui.html` 读取与 manifest 校验单元测试（纯内存，无 DB 依赖）。
 */
import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { zipSync } from "fflate";
import {
  extractUiHtmlFromPackage,
  MAX_UI_HTML_BYTES,
  readBundleUi,
  SUBMISSION_MODES,
  validateBundleManifest,
} from "../../index.ts";
import { BadRequestError } from "../../../../shared/base/errors.ts";

const enc = (s: string) => new TextEncoder().encode(s);

Deno.test("readBundleUi: 读取根级 ui.html，兼容 ./ 前缀", () => {
  assertEquals(readBundleUi({ "ui.html": enc("<p>hi</p>") }), {
    status: "ok",
    content: "<p>hi</p>",
  });
  assertEquals(readBundleUi({ "./ui.html": enc("<p>hi</p>") }), {
    status: "ok",
    content: "<p>hi</p>",
  });
});

Deno.test("readBundleUi: 缺失与超限", () => {
  assertEquals(readBundleUi({ "evaluate.py": enc("") }), {
    status: "missing",
  });
  const big = new Uint8Array(MAX_UI_HTML_BYTES + 1);
  assertEquals(readBundleUi({ "ui.html": big }), {
    status: "too_large",
    size: MAX_UI_HTML_BYTES + 1,
  });
});

Deno.test("extractUiHtmlFromPackage: 只从包中取 ui.html", () => {
  const zip = zipSync({
    "evaluate.py": enc("print(1)"),
    "ui.html": enc("<h1>界面</h1>"),
  });
  assertEquals(extractUiHtmlFromPackage(zip), "<h1>界面</h1>");
  assertEquals(
    extractUiHtmlFromPackage(zipSync({ "evaluate.py": enc("") })),
    null,
  );
  assertEquals(extractUiHtmlFromPackage(enc("不是 zip")), null);
});

Deno.test("manifest: 提交模式允许 ui，客观题与 OI 仍禁止", () => {
  assertEquals(SUBMISSION_MODES.includes("ui"), true);
  const base = {
    format_version: 1,
    title: "界面题",
    type: "P",
    submission_mode: "ui",
    runtime_config: {
      evaluator: {
        image: "noj-evaluator-python",
        time_limit_ms: 5000,
        memory_limit_mb: 256,
      },
      solution: {
        image: "noj-solution-python",
        call_timeout_ms: 2000,
        memory_limit_mb: 128,
      },
    },
  };
  assertEquals(validateBundleManifest(base).submission_mode, "ui");
  assertThrows(
    () => validateBundleManifest({ ...base, submission_mode: "nope" }),
    BadRequestError,
    "非法提交模式",
  );
  assertThrows(
    () => validateBundleManifest({ ...base, is_objective: true }),
    BadRequestError,
  );
});
