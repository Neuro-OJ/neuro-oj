/**
 * Deno 版本一致性门禁。
 *
 * 背景（2026-09-17）：CI 曾用浮动的 deno-version: v2.x，Deno 2.9.7 发布后
 * 自动升级并引入 BrokenPipe 回归，导致 UI Components 间歇性红灯
 * （测试全绿但 job 失败）。修复方式是固定版本，但**固定 28 份重复字面量**
 * 本身仍会漂移。
 *
 * 因此引入 .dvmrc 作为**唯一事实源**，并要求：
 * 1. CI 一律用 deno-version-file: .dvmrc，**禁止**再写死 deno-version: <值>；
 * 2. noj-core/Dockerfile* 的 FROM denoland/deno:* 与 .dvmrc 主次版本一致。
 *
 * 与 scripts/check-file-size.ts 同属「静态断言防漂移」的既有做法。
 */

/** 读取 .dvmrc 的版本（去掉前导 v）。 */
export function parseDvmrc(content: string): string {
  return content.trim().replace(/^v/, "");
}

/** 从 CI 文件内容中提取写死的 deno-version 值（应为空）。 */
export function findPinnedDenoVersions(content: string): string[] {
  const hits: string[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^\s*deno-version:\s*(\S+)\s*$/);
    // deno-version-file: 不匹配（冒号前必须是完整的 deno-version）
    if (m && m[1]) hits.push(m[1]);
  }
  return hits;
}

/** 从 Dockerfile 中提取 denoland/deno 镜像标签。 */
export function findDockerDenoTags(content: string): string[] {
  const hits: string[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(/^FROM\s+denoland\/deno:(\S+)/);
    if (m && m[1]) hits.push(m[1]);
  }
  return hits;
}

/** 从镜像标签中提取主次版本（alpine-2.9.5 → 2.9）。 */
export function majorMinor(tag: string): string | null {
  const m = tag.match(/(\d+)\.(\d+)/);
  return m ? m[1] + "." + m[2] : null;
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
  return out;
}

/** 主流程：返回错误列表（空数组 = 通过）。 */
export async function checkDenoVersion(root = "."): Promise<string[]> {
  const errors: string[] = [];

  let dvmrc: string;
  try {
    dvmrc = parseDvmrc(await Deno.readTextFile(root + "/.dvmrc"));
  } catch {
    return ["缺少 .dvmrc（Deno 版本的唯一事实源）：" + root + "/.dvmrc"];
  }
  if (!/^\d+\.\d+\.\d+$/.test(dvmrc)) {
    errors.push(".dvmrc 内容非法（应为如 v2.9.5）：" + dvmrc);
  }

  // 1. CI 不得写死 deno-version
  const ciFiles: string[] = [];
  for (const dir of [".github/workflows", ".github/actions"]) {
    ciFiles.push(...await collectYaml(root + "/" + dir));
  }
  if (ciFiles.length === 0) {
    errors.push("未扫描到任何 CI 文件：门禁可能失效");
  }
  let versionFileCount = 0;
  for (const file of ciFiles) {
    const content = await Deno.readTextFile(file);
    for (const pinned of findPinnedDenoVersions(content)) {
      errors.push(
        file + " 写死了 deno-version: " + pinned +
          "；请改用 deno-version-file: .dvmrc",
      );
    }
    if (content.includes("deno-version-file: .dvmrc")) versionFileCount++;
  }

  // 2. Dockerfile 的 deno 镜像与 .dvmrc 主次版本一致。
  const expected = dvmrc.split(".").slice(0, 2).join(".");
  // 2026-09-21 修复：此前只校验 noj-core 的两个 Dockerfile，而 noj-ui 与
  // noj-llm-gateway 也各自 `FROM denoland/deno:*`——它们的版本漂移**不会
  // 被门禁发现**（实测把 .dvmrc 改成 v2.10.0 并同步 core 后，两处仍留在
  // 2.9.5 却打印"检查通过"）。生产镜像与本地/CI 运行时不同版本会导致
  // "本地能跑、镜像里挂"的排查地狱，与门禁立项目的直接冲突。
  // 扫描根改为仓库内**全部** Dockerfile，避免再次遗漏新模块。
  const dockerfiles: string[] = [];
  async function collectDockerfiles(dir: string): Promise<void> {
    const entries: Deno.DirEntry[] = [];
    try {
      for await (const e of Deno.readDir(dir)) entries.push(e);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory) {
        if (e.name === "node_modules" || e.name === "target") continue;
        // 评审建议：`.deno_cache` / `.test-cache` 等缓存目录会随依赖膨胀而拖慢
        // 门禁（当前实测无命中，但成本会线性增长）；以 `.` 开头的目录一律跳过。
        if (e.name.startsWith(".")) continue;
        await collectDockerfiles(dir + "/" + e.name);
      } else if (e.name.startsWith("Dockerfile")) {
        dockerfiles.push(dir + "/" + e.name);
      }
    }
  }
  await collectDockerfiles(root);
  if (dockerfiles.length === 0) {
    // 零输入守卫：路径推导失效时「无版本漂移」是假绿。
    errors.push("未扫描到任何 Dockerfile：版本一致性门禁可能已失效");
  }
  for (const df of dockerfiles.sort()) {
    let content: string;
    try {
      content = await Deno.readTextFile(df);
    } catch {
      continue;
    }
    const rel = df.replace(root.replace(/\/$/, "") + "/", "").replace(
      /^\.\//,
      "",
    );
    for (const tag of findDockerDenoTags(content)) {
      const mm = majorMinor(tag);
      if (mm !== null && mm !== expected) {
        errors.push(
          rel + " 使用 denoland/deno:" + tag + "（主次版本 " + mm +
            "），与 .dvmrc 的 " + expected + " 不一致",
        );
      }
    }
  }

  if (versionFileCount === 0) {
    errors.push("没有任何 CI 文件使用 deno-version-file: .dvmrc");
  }
  return errors;
}

if (import.meta.main) {
  const errors = await checkDenoVersion();
  if (errors.length > 0) {
    console.error("Deno 版本一致性检查失败：");
    for (const e of errors) console.error("  - " + e);
    Deno.exit(1);
  }
  console.log("Deno 版本一致性检查通过（.dvmrc 为唯一事实源）");
}
