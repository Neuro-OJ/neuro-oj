import { join } from "@std/path";
import { fileExists } from "../util/fs.ts";
import { sha256Hex } from "../util/hash.ts";

/**
 * 从 GitHub Release 下载生产部署所需文件（docker-compose.prod.yml、
 * .env.prod.example）并做 SHA-256 校验。
 *
 * 背景（spec §3.3 洞 2）：纯 TS 重写移除 setup.sh / install.sh 后，
 * `install` 仍需要这两个文件。旧 install.sh 从源码归档（archive/<ref>.tar.gz）
 * 解压后 cp（:608-673），本模块把该职责吸收进 CLI：直接从 Release 下载
 * 同版本资产，不再依赖源码归档。
 *
 * 设计与旧脚本的对应关系：
 * - 下载 + 校验模式对照 install.sh 的 download_cli()（:535-556）：先下载资产与
 *   其 .sha256，校验正文为 64 位十六进制（大小写均可），再比较小写化摘要。
 * - ref 白名单对照 validate_ref()（:185-190）：^[A-Za-z0-9._/-]+$，非前导 /、
 *   非尾部 /、不含 ..、不含 //、非空。
 * - 使用 Deno 内置 fetch()（可注入），不 spawn curl/wget：既去掉对外部二进制的
 *   依赖，也彻底消除拼接 shell 命令带来的注入面。
 *
 * Release 资产名（由 .github/workflows/release.yml 发布，T12 依赖此契约）：
 * - docker-compose.prod.yml            + docker-compose.prod.yml.sha256
 * - .env.prod.example                  + .env.prod.example.sha256
 */

/** bootstrap 需要的 Release 资产名（不含 .sha256；顺序即下载顺序）。 */
export const RELEASE_FILES: readonly string[] = [
  "docker-compose.prod.yml",
  ".env.prod.example",
];

/** 资产下载器：返回对应 URL 的响应；默认注入全局 fetch。 */
export type Fetcher = (url: string) => Promise<Response>;

/** downloadReleaseFiles 参数。 */
export interface DownloadReleaseFilesOptions {
  /** 仓库主页地址，如 `https://github.com/Neuro-OJ/neuro-oj`。 */
  repository: string;
  /** Release ref（tag 或分支名）。 */
  ref: string;
  /** 目标安装目录。 */
  targetDir: string;
  /** 默认 false：目标文件已存在则拒绝；true 则整体覆盖。 */
  overwrite?: boolean;
  /**
   * 是否覆盖已存在文件。默认 false（拒绝）——用户会在安装目录里维护 .env.prod
   * 与手工调整过的 compose；.env.prod.example 只是模板，覆盖它收益很低。
   * 需要显式覆盖（如升级 compose 到新版本）时由调用方传 overwrite: true。
   */
  fetcher?: Fetcher;
}

/** 归一化后的仓库地址缓存无关；逐字符白名单见 validateRepository。 */
const REF_RE = /^[A-Za-z0-9._/-]+$/;
/** 对照 install.sh:551 的 `[a-fA-F0-9]{64}`：接受大小写十六进制。 */
const SHA256_RE = /^[a-fA-F0-9]{64}$/;

/** 校验并归一化仓库地址：必须 HTTPS，且不含空白 / @ / ? / #。 */
export function validateRepository(repository: string): string {
  if (!repository.startsWith("https://")) {
    throw new Error(`仓库地址必须使用 HTTPS：${repository}`);
  }
  if (/[\s@?#]/.test(repository)) {
    throw new Error(`仓库地址包含不支持的字符：${repository}`);
  }
  // 对照 install.sh 的 REPOSITORY="${REPOSITORY%/}" / "${REPOSITORY%.git}"。
  let repo = repository.replace(/\/+$/, "");
  repo = repo.replace(/\.git$/, "");
  return repo;
}

/** 校验 Release ref 字符白名单（对照 install.sh:185-190 的 validate_ref）。 */
export function validateRef(ref: string): void {
  if (
    ref === "" || !REF_RE.test(ref) || ref.startsWith("/") ||
    ref.endsWith("/") || ref.includes("..") || ref.includes("//")
  ) {
    throw new Error(`Release ref 非法：${ref}`);
  }
}

/** 拼出 GitHub Release 资产地址：<repo>/releases/download/<ref>/<asset>。 */
export function releaseAssetUrl(opts: {
  repository: string;
  ref: string;
  asset: string;
}): string {
  return `${opts.repository}/releases/download/${opts.ref}/${opts.asset}`;
}

/** 从 .sha256 文件正文解析期望摘要（首个空白分隔字段，必须 64 位 hex）。 */
function parseExpectedSha256(text: string, asset: string): string {
  const first = text.trim().split(/\s+/)[0] ?? "";
  if (!SHA256_RE.test(first)) {
    throw new Error(`${asset} 校验文件格式非法：${first || "(空)"}`);
  }
  // 对照 install.sh:553 的 tr 'A-F' 'a-f'：摘要统一小写后再比较。
  return first.toLowerCase();
}

/** 下载单个资产并校验其 .sha256；返回已校验的字节。 */
async function downloadVerified(
  opts: {
    repository: string;
    ref: string;
    asset: string;
    fetcher: Fetcher;
  },
): Promise<Uint8Array> {
  const { repository, ref, asset, fetcher } = opts;
  const url = releaseAssetUrl({ repository, ref, asset });
  const res = await fetcher(url);
  if (!res.ok) {
    throw new Error(`下载 ${asset} 失败：HTTP ${res.status}`);
  }
  // 必须先读完正文再发校验请求：fake/流式 fetcher 下避免未消费响应体。
  const bytes = new Uint8Array(await res.arrayBuffer());

  const shaRes = await fetcher(`${url}.sha256`);
  if (!shaRes.ok) {
    throw new Error(`下载 ${asset}.sha256 失败：HTTP ${shaRes.status}`);
  }
  const expected = parseExpectedSha256(await shaRes.text(), asset);
  const actual = await sha256Hex(bytes);
  if (actual !== expected) {
    throw new Error(
      `${asset} SHA-256 校验失败：期望 ${expected}，实际 ${actual}`,
    );
  }
  return bytes;
}

/**
 * 下载并校验生产文件到目标目录。
 *
 * 失败原子性：先下载 + 校验**全部**文件到 .bootstrap-<uid>.tmp 暂存文件，
 * 全部通过后才逐一 rename 进目标目录；任一步失败只删除暂存文件，目标目录
 * 不留半成品、也不覆盖原有文件。
 *
 * 返回写入的绝对路径列表（顺序与 RELEASE_FILES 一致）。
 */
export async function downloadReleaseFiles(
  opts: DownloadReleaseFilesOptions,
): Promise<string[]> {
  const repository = validateRepository(opts.repository);
  validateRef(opts.ref);
  const fetcher = opts.fetcher ?? ((url: string) => fetch(url));
  const overwrite = opts.overwrite ?? false;
  const targetDir = opts.targetDir.replace(/\/+$/, "");

  const targets = RELEASE_FILES.map((name) => join(targetDir, name));

  // 覆盖模式下目标目录已存在（安装/升级场景），缺失时按需创建；
  // 拒绝模式下目录不存在时后续同样按需创建。
  if (!overwrite) {
    for (let i = 0; i < RELEASE_FILES.length; i++) {
      if (await fileExists(targets[i]!)) {
        throw new Error(
          `${
            RELEASE_FILES[i]
          } 已存在同名文件，拒绝覆盖（如需更新请显式允许覆盖）`,
        );
      }
    }
  }

  await Deno.mkdir(targetDir, { recursive: true });

  const staged: { target: string; tmp: string }[] = [];
  try {
    // 阶段一：全部下载 + 校验到暂存文件。任一步失败都不会触碰目标文件。
    for (let i = 0; i < RELEASE_FILES.length; i++) {
      const asset = RELEASE_FILES[i]!;
      const target = targets[i]!;
      const tmp = join(
        targetDir,
        `.bootstrap-${crypto.randomUUID()}.tmp`,
      );
      const bytes = await downloadVerified({
        repository,
        ref: opts.ref,
        asset,
        fetcher,
      });
      await Deno.writeFile(tmp, bytes);
      staged.push({ target, tmp });
    }

    // 阶段二：全部校验通过后才提交（rename 为原子替换）。
    for (const { target, tmp } of staged) {
      await Deno.rename(tmp, target);
    }
    return targets;
  } finally {
    // 未提交的暂存文件（含部分提交后剩下的）全部清理。
    for (const { tmp } of staged) {
      await Deno.remove(tmp).catch(() => {});
    }
  }
}
