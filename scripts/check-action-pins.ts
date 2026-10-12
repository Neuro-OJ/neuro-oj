/**
 * GitHub Actions 引用固定门禁（审计 S1）。
 *
 * 背景（2026-09-28 无人值守审计面 8）：`.github` 下 175 处 `uses:` 中**零处**固定到
 * commit SHA，而 `release.yml` 持有 `packages / id-token / attestations / contents: write`
 * 并以 `--clobber` 覆盖 Release 资产——任一上游 action 的可变 tag 被篡改，即可污染所有
 * 后续 install/update。更糟的是 `dependabot.yml` 注释声称"已 SHA 钉"、发布前检查
 * 只校验 Dockerfile，形成虚假安全感。
 *
 * 规则：
 * 1. 外部 action 必须写成 `owner/repo[/path]@<40 位 SHA> # <版本>`，版本注释供人读与
 *    Dependabot 升级时同步改写；
 * 2. `docker://` 镜像必须固定 `@sha256:<64 位 digest>`；
 * 3. 本地 action（`./` 开头）不受限。
 *
 * 与 scripts/check-deno-version.ts 同属「静态断言防漂移」的既有做法。
 */

/** 单条违规。 */
export interface PinViolation {
  file: string;
  line: number;
  ref: string;
  reason: string;
}

const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /@sha256:[0-9a-f]{64}$/;

/** 从 workflow / composite action 内容中找出未固定的 `uses:` 引用。 */
export function findUnpinnedUses(
  file: string,
  content: string,
): PinViolation[] {
  const out: PinViolation[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s*#/.test(raw)) continue;
    const m = raw.match(/^\s*(?:-\s+)?uses:\s*(['"]?)([^\s'"#]+)\1\s*(#.*)?$/);
    if (!m) continue;
    const ref = m[2];
    const comment = (m[3] ?? "").replace(/^#\s*/, "").trim();
    if (ref.startsWith("./")) continue;
    if (ref.startsWith("docker://")) {
      if (!DIGEST_RE.test(ref)) {
        out.push({
          file,
          line: i + 1,
          ref,
          reason: "docker 镜像未固定 @sha256 digest",
        });
      }
      continue;
    }
    const at = ref.lastIndexOf("@");
    const version = at >= 0 ? ref.slice(at + 1) : "";
    if (!SHA_RE.test(version)) {
      out.push({
        file,
        line: i + 1,
        ref,
        reason: "未固定到 40 位 commit SHA",
      });
    } else if (!comment) {
      out.push({
        file,
        line: i + 1,
        ref,
        reason: "SHA 固定缺少版本注释（如 `# v4.4.0`）",
      });
    }
  }
  return out;
}

/** 递归收集目录下的 yml/yaml 文件。 */
async function collectYaml(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const entries: Deno.DirEntry[] = [];
    try {
      for await (const e of Deno.readDir(current)) entries.push(e);
    } catch {
      return;
    }
    for (const e of entries) {
      const path = current + "/" + e.name;
      if (e.isDirectory) await walk(path);
      else if (e.name.endsWith(".yml") || e.name.endsWith(".yaml")) {
        out.push(path);
      }
    }
  }
  await walk(dir);
  return out.sort();
}

/** 主流程：返回错误列表（空数组 = 通过）与扫描到的引用数。 */
export async function checkActionPins(
  root = ".",
): Promise<{ errors: string[]; scanned: number }> {
  const files = [
    ...await collectYaml(root + "/.github/workflows"),
    ...await collectYaml(root + "/.github/actions"),
  ];
  // 零输入守卫：路径推导失效时「无违规」是假绿
  if (files.length === 0) {
    return {
      errors: ["未扫描到任何 workflow 文件：门禁可能已失效"],
      scanned: 0,
    };
  }
  const errors: string[] = [];
  let scanned = 0;
  for (const file of files) {
    const content = await Deno.readTextFile(file);
    scanned += (content.match(/^\s*(?:-\s+)?uses:/gm) ?? []).length;
    for (const v of findUnpinnedUses(file, content)) {
      errors.push(`${v.file}:${v.line} ${v.ref} —— ${v.reason}`);
    }
  }
  return { errors, scanned };
}

if (import.meta.main) {
  const { errors, scanned } = await checkActionPins();
  if (errors.length > 0) {
    console.error("GitHub Actions 引用固定检查失败：");
    for (const e of errors) console.error("  - " + e);
    console.error(
      "修复：改为 `owner/repo@<commit SHA> # <版本>`；SHA 可用 " +
        "`gh api repos/<owner>/<repo>/commits/<tag> -q .sha` 查询。",
    );
    Deno.exit(1);
  }
  console.log(`GitHub Actions 引用固定检查通过（${scanned} 处 uses）`);
}
