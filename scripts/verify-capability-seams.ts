/**
 * Capability Seam 依赖方向校验。
 *
 * 规则：业务代码不得直接 import 具体 Provider 实现，只允许**装配点**引用
 * （接口 + 工厂 + 单一装配处）。
 *
 * ── 修复记录（2026-09-12 架构评审 §2.3）──────────────────────────────
 * 本门禁此前是一盏**永久空转的假绿灯**，两处叠加导致它从未生效：
 *   1. 路径全部指向已不存在的旧目录（`lib/storage/local.ts` 等），代码早已迁到
 *      `domains/system/services/...`；
 *   2. import 说明符是**相对于导入文件**的（`./email-providers/mock.ts`），
 *      却直接与"相对 src 根"的路径做精确字符串比较，即便路径改对也永远不相等；
 *   3. 只匹配静态 `from "..."`，而装配点实际用的是**动态** `await import("...")`；
 *   4. 没有任何自检，路径失效后只报告"通过"，且已接入 CI（每个 PR 都跑）。
 *
 * 现在：解析相对路径后比较 + 覆盖动态 import + 四条自检（见 `verifyCapabilitySeams`），
 * 任何一条失效都会让门禁**失败**而不是静默通过。
 */
import { dirname, relative, resolve } from "node:path";

const DEFAULT_ROOT = resolve(
  import.meta.dirname ?? ".",
  "..",
  "noj-core",
  "src",
);

/** 具体 Provider 实现（相对 src 的路径）。 */
export const CONCRETE_PROVIDERS: readonly string[] = [
  // 对象存储
  "domains/system/services/storage/local.ts",
  "domains/system/services/storage/s3.ts",
  // 邮件
  "domains/system/services/email-providers/disabled.ts",
  "domains/system/services/email-providers/mock.ts",
  "domains/system/services/email-providers/aliyun.ts",
  "domains/system/services/email-providers/tencent.ts",
  // 内容审核（2026-09-12 评审补充：该家族同样只有装配点 index.ts 可引用）
  "domains/content-review/providers/mock.ts",
  "domains/content-review/providers/aliyun.ts",
  "domains/content-review/providers/tencent.ts",
];

/** 允许引用具体 Provider 的装配点（相对 src 的路径）。 */
export const ALLOWED_IMPORTERS: readonly string[] = [
  "domains/system/services/storage/factory.ts",
  "domains/system/services/storage/mod.ts",
  "domains/system/services/email.ts",
  "domains/content-review/providers/index.ts",
];

/** 测试代码不受本规则约束（需要直接构造 mock provider）。 */
function isTestFile(relPath: string): boolean {
  return relPath.includes("/tests/") || relPath.endsWith("_test.ts") ||
    relPath.endsWith(".test.ts");
}

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

/**
 * 提取文件中的 import 说明符（静态 `from "x"` 与动态 `import("x")` 都算）。
 */
export function extractImportSpecifiers(text: string): string[] {
  const specs: string[] = [];
  const staticRe = /from\s+["']([^"']+)["']/g;
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [staticRe, dynamicRe]) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      if (match[1]) specs.push(match[1]);
    }
  }
  return specs;
}

/**
 * 把 import 说明符解析为"相对 src 根"的路径；非相对说明符（npm:/jsr:/node: 等）
 * 返回 null。
 */
export function resolveSpecifierToRootRelative(
  importerRelPath: string,
  spec: string,
): string | null {
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
  const importerDir = dirname(importerRelPath);
  const resolved = resolve("/", importerDir, spec); // 以 / 为虚拟根做纯路径运算
  return relative("/", resolved);
}

export interface CapabilitySeamResult {
  errors: string[];
  /** 诊断信息（成功时也会打印，便于确认门禁"真的在检查东西"） */
  stats: {
    scanned_files: number;
    provider_paths: number;
    provider_references: number;
    violations: number;
  };
}

/**
 * 执行校验。四条自检任一不成立即失败：
 *   1. Provider 路径必须真实存在（防路径漂移）；
 *   2. 装配点路径必须真实存在；
 *   3. 扫描到的 import 说明符总数 > 0（防解析规则失效）；
 *   4. 至少解析到一次对具体 Provider 的引用（防规则恒真）。
 */
export function verifyCapabilitySeams(
  root = DEFAULT_ROOT,
): CapabilitySeamResult {
  const errors: string[] = [];

  // 自检 1/2：白名单路径必须存在
  for (const p of [...CONCRETE_PROVIDERS, ...ALLOWED_IMPORTERS]) {
    try {
      Deno.statSync(`${root}/${p}`);
    } catch {
      errors.push(
        `白名单路径不存在：${p}（Provider 已迁移但门禁未同步 → 规则会静默失效）`,
      );
    }
  }

  const files = collectTsFiles(root);
  if (files.length === 0) {
    errors.push(`未扫描到任何 TS 文件（root=${root}），门禁已失去检查对象`);
  }

  let specCount = 0;
  let providerReferences = 0;
  let violations = 0;

  for (const filePath of files) {
    const rel = relative(root, filePath);
    if (isTestFile(rel)) continue;
    const text = Deno.readTextFileSync(filePath);
    for (const spec of extractImportSpecifiers(text)) {
      specCount++;
      const resolved = resolveSpecifierToRootRelative(rel, spec);
      if (resolved === null) continue;
      if (!CONCRETE_PROVIDERS.includes(resolved)) continue;
      providerReferences++;
      if (!ALLOWED_IMPORTERS.includes(rel)) {
        violations++;
        errors.push(
          `${rel} 不得直接 import 具体 Provider ${resolved}（应通过接口/工厂）`,
        );
      }
    }
  }

  // 自检 3：解析规则必须真的在工作
  if (specCount === 0) {
    errors.push(
      `在 ${files.length} 个文件中未解析到任何 import 说明符——import 解析规则已失效`,
    );
  }
  // 自检 4：规则必须真的能命中（否则是恒真断言）
  if (providerReferences === 0) {
    errors.push(
      "未解析到任何对具体 Provider 的引用——门禁已成恒真断言（通常是相对路径解析或白名单失效）",
    );
  }

  return {
    errors,
    stats: {
      scanned_files: files.length,
      provider_paths: CONCRETE_PROVIDERS.length,
      provider_references: providerReferences,
      violations,
    },
  };
}

if (import.meta.main) {
  const { errors, stats } = verifyCapabilitySeams();
  if (errors.length > 0) {
    console.error("Capability Seam 校验失败：");
    for (const err of errors) {
      console.error(`- ${err}`);
    }
    Deno.exit(1);
  }
  console.log(
    `Capability Seam 校验通过（扫描 ${stats.scanned_files} 文件 / ` +
      `${stats.provider_paths} 个 Provider / ${stats.provider_references} 处装配点引用）`,
  );
}
