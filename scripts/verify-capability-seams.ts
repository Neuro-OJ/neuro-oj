// Capability Seam 依赖方向校验。
// 禁止 noj-core/src 业务代码直接 import 具体 Provider 实现，只允许装配点引用。
import { relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname ?? ".", "..", "noj-core", "src");

const CONCRETE_PROVIDERS = [
  "lib/storage/local.ts",
  "lib/storage/s3.ts",
  "lib/email-providers/mock.ts",
  "lib/email-providers/aliyun.ts",
  "lib/email-providers/tencent.ts",
];

/** 允许引用具体 Provider 的装配点（相对 src 的路径）。 */
const ALLOWED_IMPORTERS = [
  "lib/storage/factory.ts",
  "lib/storage/mod.ts",
  "lib/email.ts",
  "lib/email-providers/index.ts",
];

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      files.push(...collectTsFiles(path));
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function normalizeImport(spec: string): string {
  return spec.replace(/^\.\//, "").replace(/\.ts$/, "") + ".ts";
}

function verifyFile(filePath: string): string[] {
  const errors: string[] = [];
  const rel = relative(ROOT, filePath);
  const text = Deno.readTextFileSync(filePath);
  const re = /from\s+["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const spec = normalizeImport(match[1]);
    for (const provider of CONCRETE_PROVIDERS) {
      if (spec === provider && !ALLOWED_IMPORTERS.includes(rel)) {
        errors.push(
          `${rel} 不得直接 import 具体 Provider ${provider}（应通过接口/工厂）`,
        );
      }
    }
  }
  return errors;
}

if (import.meta.main) {
  const errors: string[] = [];
  for (const file of collectTsFiles(ROOT)) {
    errors.push(...verifyFile(file));
  }
  if (errors.length > 0) {
    console.error("Capability Seam 校验失败：");
    for (const err of errors) {
      console.error(`- ${err}`);
    }
    Deno.exit(1);
  }
  console.log("Capability Seam 校验通过");
}
