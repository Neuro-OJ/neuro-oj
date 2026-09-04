/** noj-server 二进制按需下载与版本解析。 */

import { sha256Hex } from "../util/hash.ts";

const REPO = "Neuro-OJ/neuro-oj";
const DEFAULT_BASE_URL = `https://github.com/${REPO}/releases/download`;
const API_BASE = `https://api.github.com/repos/${REPO}`;

/** 当前内置默认版本（网络不可用时的回退值）。 */
export const DEFAULT_NOJ_SERVER_VERSION = "0.1.0";

/** 解析 GitHub 最新 Release 的精确版本号（去掉前导 v）。 */
export async function resolveLatestVersion(): Promise<string> {
  const res = await fetch(`${API_BASE}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) {
    throw new Error(`解析最新版本失败: GitHub API ${res.status}`);
  }
  const data = await res.json() as { tag_name?: string };
  const tag = data.tag_name;
  if (!tag) {
    throw new Error("解析最新版本失败: 响应缺少 tag_name");
  }
  return tag.replace(/^v/, "");
}

/** 确保 install_dir/bin/noj-server 存在且版本匹配；缺失时自动下载并校验。 */
export async function ensureNojServerBinary(
  opts: {
    installDir: string;
    version?: string;
    baseUrl?: string;
  },
): Promise<string> {
  const version = opts.version ?? await resolveLatestVersion();
  const binDir = `${opts.installDir}/bin`;
  const binPath = `${binDir}/noj-server`;
  const versionFile = `${binDir}/noj-server.version`;

  await Deno.mkdir(binDir, { recursive: true });

  // 已存在且版本一致：直接复用。
  try {
    const installed = (await Deno.readTextFile(versionFile)).trim();
    if (installed === version && (await Deno.stat(binPath)).isFile) {
      return binPath;
    }
  } catch {
    // 无版本文件或二进制缺失，继续下载。
  }

  // 已存在但无版本文件：视为用户自建二进制，不覆盖。
  try {
    if ((await Deno.stat(binPath)).isFile) {
      return binPath;
    }
  } catch {
    // 二进制不存在，继续下载。
  }

  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const asset = "noj-server-linux-amd64";
  const url = `${baseUrl}/${version}/${asset}`;
  const tmp = `${binDir}/.noj-server-${Deno.pid}-${crypto.randomUUID()}.tmp`;

  try {
    const [binRes, shaRes] = await Promise.all([
      fetch(url),
      fetch(`${url}.sha256`),
    ]);
    if (!binRes.ok) {
      throw new Error(`下载 noj-server 失败: HTTP ${binRes.status} ${url}`);
    }
    if (!shaRes.ok) {
      throw new Error(`下载 noj-server 校验文件失败: HTTP ${shaRes.status}`);
    }
    const binBytes = new Uint8Array(await binRes.arrayBuffer());
    const shaText = await shaRes.text();
    const expected = shaText.trim().split(/\s+/)[0] ?? "";
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      throw new Error("noj-server SHA-256 校验文件格式非法");
    }
    const actual = await sha256Hex(binBytes);
    if (actual !== expected) {
      throw new Error(
        `noj-server SHA-256 校验失败：期望 ${expected}，实际 ${actual}`,
      );
    }
    await Deno.writeFile(tmp, binBytes);
    await Deno.chmod(tmp, 0o755);
    await Deno.rename(tmp, binPath);
    await Deno.writeTextFile(versionFile, `${version}\n`);
    return binPath;
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
}
