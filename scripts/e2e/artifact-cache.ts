/**
 * 本地 E2E 构建产物缓存（P6-B）。
 *
 * 目的：本地反复跑 E2E 时，UI 构建与题目支持包是分钟级成本。这里用「输入
 * fingerprint + 产物摘要」判断能否复用，而不是只看产物是否存在：
 *
 * - fingerprint：所有输入文件（源码、构建脚本、锁文件）按路径 + 内容哈希归并；
 *   任一输入变化 → 指纹变化 → 必须重建；
 * - digest：产物（目录或文件）按路径 + 内容哈希归并；产物被删改 → 摘要不匹配
 *   → 必须重建，绝不拿旧产物冒充命中；
 * - 缓存记录只是「上次成功构建的证据」，读不到 / 损坏都按未命中处理。
 *
 * 纯逻辑可注入（listFiles / hashFile），零依赖测试直接喂临时目录。
 */

/** 一条产物缓存记录；写入 noj-tests/test-results/e2e-cache/<name>.json。 */
export interface ArtifactCacheRecord {
  version: 1;
  name: string;
  /** 输入指纹；与本次计算结果不同即失效。 */
  fingerprint: string;
  /** 产物摘要；与实际产物不同即视为损坏。 */
  digest: string;
  /** 参与摘要的产物路径（相对仓库根），便于审计。 */
  artifacts: string[];
  builtAt: string;
}

/** 一个可缓存产物：输入集合 → 产物路径。 */
export interface ArtifactSpec {
  /** 缓存标识，也是文件名：ui / support-packages。 */
  name: string;
  /** 输入路径（相对仓库根）；目录按 ignore 过滤后递归展开。 */
  inputs: string[];
  /** 产物路径（相对仓库根）；文件或目录。 */
  artifact: string;
  /** 目录输入需要跳过的路径片段。 */
  ignore: RegExp[];
}

/** 命中判定结果。 */
export interface ArtifactState {
  name: string;
  fingerprint: string;
  digest: string;
  /** 产物是否存在。 */
  present: boolean;
  /** 是否可以跳过构建。 */
  reusable: boolean;
  /** hit / missing-artifact / fingerprint-changed / digest-mismatch / no-cache。 */
  reason: string;
}

/** 可注入的文件操作（默认实现走真实文件系统）。 */
export interface ArtifactDeps {
  /** 列出目录下所有文件的绝对路径（递归，按 ignore 过滤）。 */
  listFiles: (root: string, ignore: RegExp[]) => Promise<string[]>;
  /** 读取文件内容哈希（sha256 hex）。 */
  hashFile: (path: string) => Promise<string>;
  /** 是否存在。 */
  exists: (path: string) => Promise<boolean>;
}

/** 缓存读写；文件实现与内存实现都满足该接口。 */
export interface ArtifactCacheStore {
  read(name: string): Promise<ArtifactCacheRecord | undefined>;
  write(record: ArtifactCacheRecord): Promise<void>;
}

const DEFAULT_IGNORE = [
  /\/(?:node_modules|\.git|\.nuxt|\.output|test-results)\//,
];

async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input;
  // 转成独立 ArrayBuffer：crypto.subtle.digest 不接受可能共享的内存视图。
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function listFilesRecursive(
  root: string,
  ignore: RegExp[] = DEFAULT_IGNORE,
): Promise<string[]> {
  const normalized = root.replace(/\/+$/, "");
  const stat = await Deno.stat(normalized).catch(() => undefined);
  if (!stat) return [];
  if (stat.isFile) return [normalized];
  const files: string[] = [];
  for await (const entry of Deno.readDir(normalized)) {
    const child = normalized + "/" + entry.name;
    const relative = child + "/";
    if (entry.isDirectory) {
      if (ignore.some((pattern) => pattern.test(relative))) continue;
      files.push(...await listFilesRecursive(child, ignore));
      continue;
    }
    if (!entry.isFile) continue;
    if (ignore.some((pattern) => pattern.test(relative))) continue;
    files.push(child);
  }
  return files.sort();
}

/** 默认文件依赖：真实文件系统 + 内容哈希。 */
export const defaultArtifactDeps: ArtifactDeps = {
  listFiles: (root, ignore) => listFilesRecursive(root, ignore),
  hashFile: async (path) => sha256Hex(await Deno.readFile(path)),
  exists: async (path) => {
    try {
      await Deno.stat(path);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * 归并一批「路径 + 哈希」为稳定指纹。
 *
 * 先按路径排序再拼接，避免文件系统枚举顺序影响结果。
 */
export async function fingerprintEntries(
  entries: Array<{ path: string; hash: string }>,
): Promise<string> {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  return await sha256Hex(
    sorted.map((entry) => entry.path + "\u0000" + entry.hash).join("\n"),
  );
}

function joinRoot(repoRoot: string, relative: string): string {
  const root = repoRoot.replace(/\/+$/, "");
  return root === "" ? relative : root + "/" + relative;
}

function stripRoot(repoRoot: string, absolute: string): string {
  const root = repoRoot.replace(/\/+$/, "");
  return root === "" ? absolute : absolute.slice(root.length + 1);
}

/** 计算输入集合的指纹；路径相对仓库根，输出与调用顺序无关。 */
export async function fingerprintInputs(
  repoRoot: string,
  inputs: string[],
  ignore: RegExp[] = DEFAULT_IGNORE,
  deps: ArtifactDeps = defaultArtifactDeps,
): Promise<string> {
  const entries: Array<{ path: string; hash: string }> = [];
  for (const input of inputs) {
    const absolute = joinRoot(repoRoot, input);
    for (const file of await deps.listFiles(absolute, ignore)) {
      entries.push({
        path: stripRoot(repoRoot, file),
        hash: await deps.hashFile(file),
      });
    }
  }
  return await fingerprintEntries(entries);
}

/** 产物摘要：目录展开为全部文件的「路径 + 哈希」归并。 */
export async function digestArtifact(
  repoRoot: string,
  artifact: string,
  deps: ArtifactDeps = defaultArtifactDeps,
): Promise<{ digest: string; artifacts: string[] }> {
  const files = await deps.listFiles(joinRoot(repoRoot, artifact), []);
  if (files.length === 0) return { digest: "", artifacts: [] };
  const artifacts = files.map((file) => stripRoot(repoRoot, file));
  const entries = await Promise.all(
    files.map(async (file) => ({
      path: file,
      hash: await deps.hashFile(file),
    })),
  );
  return { digest: await fingerprintEntries(entries), artifacts };
}

/**
 * 判定产物是否可复用。
 *
 * 命中必须同时满足：产物存在 + 缓存记录存在 + 指纹一致 + 摘要一致。
 * 只满足前两条就复用会把「源码变了但产物还是旧的」当成命中，必须避免。
 */
export async function inspectArtifact(
  spec: ArtifactSpec,
  repoRoot: string,
  cache: ArtifactCacheStore,
  deps: ArtifactDeps = defaultArtifactDeps,
): Promise<ArtifactState> {
  const fingerprint = await fingerprintInputs(
    repoRoot,
    spec.inputs,
    spec.ignore,
    deps,
  );
  const present = await deps.exists(joinRoot(repoRoot, spec.artifact));
  if (!present) {
    return {
      name: spec.name,
      fingerprint,
      digest: "",
      present: false,
      reusable: false,
      reason: "missing-artifact",
    };
  }
  const { digest } = await digestArtifact(repoRoot, spec.artifact, deps);
  const record = await cache.read(spec.name).catch(() => undefined);
  if (!record) {
    return {
      name: spec.name,
      fingerprint,
      digest,
      present: true,
      reusable: false,
      reason: "no-cache",
    };
  }
  if (record.fingerprint !== fingerprint) {
    return {
      name: spec.name,
      fingerprint,
      digest,
      present: true,
      reusable: false,
      reason: "fingerprint-changed",
    };
  }
  if (record.digest !== digest) {
    return {
      name: spec.name,
      fingerprint,
      digest,
      present: true,
      reusable: false,
      reason: "digest-mismatch",
    };
  }
  return {
    name: spec.name,
    fingerprint,
    digest,
    present: true,
    reusable: true,
    reason: "hit",
  };
}

/** 构建成功后记录产物指纹与摘要（供下一次命中判定）。 */
export async function recordArtifact(
  spec: ArtifactSpec,
  repoRoot: string,
  cache: ArtifactCacheStore,
  deps: ArtifactDeps = defaultArtifactDeps,
  now: Date = new Date(),
): Promise<ArtifactCacheRecord> {
  const emptyStore: ArtifactCacheStore = {
    read: () => Promise.resolve(undefined),
    write: () => Promise.resolve(),
  };
  const state = await inspectArtifact(spec, repoRoot, emptyStore, deps);
  if (!state.present) {
    throw new Error(
      "构建后仍找不到产物 " + spec.artifact + "；拒绝写入缓存记录",
    );
  }
  const { artifacts } = await digestArtifact(repoRoot, spec.artifact, deps);
  const record: ArtifactCacheRecord = {
    version: 1,
    name: spec.name,
    fingerprint: state.fingerprint,
    digest: state.digest,
    artifacts,
    builtAt: now.toISOString(),
  };
  await cache.write(record);
  return record;
}

/** 目录型缓存存储（每个产物一个 JSON 文件）。 */
export function createFileCacheStore(dir: string): ArtifactCacheStore {
  const base = dir.replace(/\/+$/, "");
  return {
    async read(name) {
      const path = base + "/" + name + ".json";
      try {
        const raw = await Deno.readTextFile(path);
        const record = JSON.parse(raw) as ArtifactCacheRecord;
        if (record.version !== 1 || record.name !== name) return undefined;
        return record;
      } catch {
        // 损坏或缺失都按未命中处理：缓存只影响快慢，不影响正确性。
        return undefined;
      }
    },
    async write(record) {
      await Deno.mkdir(base, { recursive: true });
      const path = base + "/" + record.name + ".json";
      const temporary = path + "." + Deno.pid + ".tmp";
      await Deno.writeTextFile(
        temporary,
        JSON.stringify(record, null, 2) + "\n",
      );
      await Deno.rename(temporary, path);
    },
  };
}

/** 人类可读的复用结论（写进日志与清单）。 */
export function describeArtifactState(state: ArtifactState): string {
  const verdict = state.reusable ? "复用" : "重建";
  const presence = state.present ? "存在" : "缺失";
  return state.name + ": " + verdict + "（" + state.reason + "，产物=" +
    presence + "）";
}
