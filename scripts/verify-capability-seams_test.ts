/**
 * Capability Seam 门禁的自测。
 *
 * 门禁本身必须被测试：本次评审发现它曾长期"恒真通过"（§2.3），
 * 因此这里既测规则命中，也测**失效检测**（路径漂移、恒真断言）。
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  ALLOWED_IMPORTERS,
  CONCRETE_PROVIDERS,
  extractImportSpecifiers,
  resolveSpecifierToRootRelative,
  verifyCapabilitySeams,
} from "./verify-capability-seams.ts";

const REAL_ROOT = new URL("../noj-core/src", import.meta.url).pathname;

/** 构造一个"白名单路径都存在"的临时 src 根，再按需加入被测文件。 */
async function makeFixtureRoot(
  files: Record<string, string> = {},
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "cap-seam-" });
  for (const p of [...CONCRETE_PROVIDERS, ...ALLOWED_IMPORTERS]) {
    const full = `${root}/${p}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, "export {};\n");
  }
  for (const [p, content] of Object.entries(files)) {
    const full = `${root}/${p}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, content);
  }
  return root;
}

Deno.test("capability-seam: 真实仓库通过且规则确实命中（非恒真）", () => {
  const { errors, stats } = verifyCapabilitySeams(REAL_ROOT);
  assertEquals(errors, []);
  assert(
    stats.provider_references > 0,
    "必须解析到装配点对具体 Provider 的引用，否则规则是恒真的",
  );
  assertEquals(stats.violations, 0);
});

Deno.test("capability-seam: 业务代码直接 import 具体 Provider 会被拦截", async () => {
  const root = await makeFixtureRoot({
    "domains/catalog/services/bad.ts":
      `import { S3StorageProvider } from "../../system/services/storage/s3.ts";\n`,
  });
  try {
    const { errors } = verifyCapabilitySeams(root);
    assert(errors.length > 0, "应报告违规");
    assert(
      errors.some((e) => e.includes("domains/catalog/services/bad.ts")),
      `错误信息应包含违规文件：${errors.join(" | ")}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("capability-seam: 动态 import 同样被覆盖", async () => {
  const root = await makeFixtureRoot({
    "domains/catalog/services/bad-dynamic.ts":
      `const m = await import("../../system/services/email-providers/aliyun.ts");\n`,
  });
  try {
    const { errors } = verifyCapabilitySeams(root);
    assert(
      errors.some((e) => e.includes("bad-dynamic.ts")),
      "动态 import 必须被覆盖（装配点实际用的就是动态 import）",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("capability-seam: 装配点引用不报错", async () => {
  const root = await makeFixtureRoot({
    "domains/system/services/storage/factory.ts":
      `const { S3StorageProvider } = await import("./s3.ts");\n`,
  });
  try {
    const { errors, stats } = verifyCapabilitySeams(root);
    assertEquals(errors, []);
    assert(stats.provider_references >= 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("capability-seam: 测试文件豁免", async () => {
  const root = await makeFixtureRoot({
    // 合法装配点引用，保证门禁的"非恒真"自检通过
    "domains/system/services/storage/factory.ts":
      `const { S3StorageProvider } = await import("./s3.ts");\n`,
    // 测试文件直接 import mock provider 属正常用法，不应报错
    "domains/system/tests/services/x.test.ts":
      `import { MockEmailProvider } from "../../services/email-providers/mock.ts";\n`,
  });
  try {
    const { errors } = verifyCapabilitySeams(root);
    assertEquals(errors, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("capability-seam: 白名单路径漂移会被自检拦下", async () => {
  const root = await makeFixtureRoot();
  try {
    // 删掉一个 Provider 文件，模拟"代码迁移但门禁未同步"
    await Deno.remove(`${root}/${CONCRETE_PROVIDERS[0]}`);
    const { errors } = verifyCapabilitySeams(root);
    assert(
      errors.some((e) => e.includes("白名单路径不存在")),
      `路径漂移必须失败（这正是本次缺陷的成因）：${errors.join(" | ")}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("capability-seam: 无任何 Provider 引用时判定门禁失效（恒真断言）", async () => {
  const root = await makeFixtureRoot();
  try {
    const { errors } = verifyCapabilitySeams(root);
    assert(
      errors.some((e) => e.includes("恒真断言")),
      `规则空转必须失败：${errors.join(" | ")}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("capability-seam: 相对说明符按导入文件目录解析", () => {
  assertEquals(
    resolveSpecifierToRootRelative(
      "domains/system/services/email.ts",
      "./email-providers/mock.ts",
    ),
    "domains/system/services/email-providers/mock.ts",
  );
  assertEquals(
    resolveSpecifierToRootRelative(
      "domains/catalog/services/x.ts",
      "../../system/services/storage/s3.ts",
    ),
    "domains/system/services/storage/s3.ts",
  );
  // 非相对说明符（npm:/jsr:/node:）不参与本规则
  assertEquals(
    resolveSpecifierToRootRelative("a/b.ts", "npm:drizzle-orm@0.45.2"),
    null,
  );
});

Deno.test("capability-seam: 静态与动态 import 说明符都能提取", () => {
  const text = [
    `import { a } from "./a.ts";`,
    `export { b } from "../b.ts";`,
    `const c = await import("./c.ts");`,
    `const d = import("./d.ts");`,
  ].join("\n");
  const specs = extractImportSpecifiers(text);
  assertEquals(specs.sort(), ["./a.ts", "../b.ts", "./c.ts", "./d.ts"].sort());
});
