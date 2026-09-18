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
  /**
   * 是否覆盖已存在文件。默认 false（拒绝）——用户会在安装目录里维护 .env.prod
   * 与手工调整过的 compose；.env.prod.example 只是模板，覆盖它收益很低。
   * 需要显式覆盖（如升级 compose 到新版本）时由调用方传 overwrite: true。
   */
  overwrite?: boolean;
  /** 资产下载器注入点；缺省为全局 fetch。 */
  fetcher?: Fetcher;
}

/** Release ref 的逐字符白名单（字母 / 数字 / `.` `_` `/` `-`），语义见 validateRef。 */
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

/**
 * 校验并归一化目标安装目录，对照 install.sh:177-181 的安全防护。
 *
 * 拒绝：
 * - 空串或仅含空白字符（归一化后为空则无法作为目录）
 * - 恰为 `/`、`.`、`..`（写入根 / 当前 / 上级目录都是破坏性的）
 * - 含 `\n` 或 `\r`（防止换行注入沾污后续输出）
 *
 * 返回去除尾部 `/` 后的安全目录：由于已拒绝 `/`，结果永远非空，
 * 不会像旧实现那样退化为 `""` 而把文件静默写进当前工作目录。
 */
export function validateTargetDir(dir: string): string {
  if (dir.includes("\n") || dir.includes("\r")) {
    throw new Error(`安装目录不能包含换行符：${JSON.stringify(dir)}`);
  }
  const normalized = dir.replace(/\/+$/, "");
  if (
    normalized === "" || normalized === "/" || normalized === "." ||
    normalized === ".." || dir.trim() === ""
  ) {
    throw new Error(`安装目录不安全或为空：${JSON.stringify(dir)}`);
  }
  return normalized;
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
 * 失败原子性（两阶段提交）：
 * - 阶段一：把**全部**文件下载 + 校验到 `.bootstrap-<uid>.tmp` 暂存文件；
 *   任一步失败都不会触碰目标文件。
 * - 阶段二：提交前先把将被覆盖的普通文件 rename 到 `.bootstrap-<uid>.bak`
 *   备份，再逐个把暂存文件 rename 进目标目录。任意一次 rename 失败即回滚：
 *   删除已提交的新文件、还原备份，因此不会出现“新 compose + 旧 example”
 *   的混合状态；回滚自身失败不会被吞掉，而是连同可恢复的备份路径一并报出。
 * - `finally` 无条件清理所有暂存文件与备份文件，失败路径也不留残留。
 *
 * 目标目录必须先通过 `validateTargetDir`：`/`、空串、`.`、`..`
 * 会被拒绝（对照 install.sh:177-181），绝不会静默写进当前工作目录。
 *
 * 返回写入的绝对路径列表（顺序与 RELEASE_FILES 一致）。
 */
export async function downloadReleaseFiles(
  opts: DownloadReleaseFilesOptions,
): Promise<string[]> {
  const repository = validateRepository(opts.repository);
  validateRef(opts.ref);
  // 在任何文件系统访问之前拒绝危险目标目录。
  const targetDir = validateTargetDir(opts.targetDir);
  const fetcher = opts.fetcher ?? ((url: string) => fetch(url));
  const overwrite = opts.overwrite ?? false;

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
  // 提交期间创建的备份：旧文件 rename 到 `.bootstrap-<uid>.bak`，回滚时还原。
  const backups: { target: string; bak: string }[] = [];
  // 已提交（rename 进目标目录）的新文件，回滚时删除。
  const committed: string[] = [];
  // 回滚失败的备份路径：finally 必须保留它们（见 catch 内说明）。
  const keepBackups = new Set<string>();
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

    // 阶段二：事务式提交。先备份将被覆盖的普通文件，再逐个 rename 进去；
    // 任一步失败都回滚到提交前的完整状态，不留混合状态。
    for (const { target, tmp } of staged) {
      if (await fileExists(target)) {
        const bak = `${target}.bootstrap-${crypto.randomUUID()}.bak`;
        await Deno.rename(target, bak);
        backups.push({ target, bak });
      }
      await Deno.rename(tmp, target);
      committed.push(target);
    }
    return targets;
  } catch (err) {
    const problems: string[] = [];
    // 最新提交的先回滚；best-effort，失败不吞掉、累积到报告中。
    for (const target of committed.reverse()) {
      await Deno.remove(target).catch((e) => {
        problems.push(`删除已提交文件 ${target} 失败：${e.message}`);
      });
    }
    for (const { target, bak } of backups) {
      await Deno.rename(bak, target).catch((e) => {
        keepBackups.add(bak);
        problems.push(
          `还原备份 ${bak} -> ${target} 失败：${e.message}（旧文件仍在 ${bak}）`,
        );
      });
    }
    const detail = problems.length > 0
      ? `；回滚未完全成功：${problems.join("；")}`
      : "";
    throw new Error(
      `提交部署文件失败，已回滚：${(err as Error).message}${detail}`,
      { cause: err },
    );
  } finally {
    // 未提交的暂存文件全部清理；
    // 回滚成功时备份已被 rename 回去，remove 为 no-op。
    for (const { tmp } of staged) {
      await Deno.remove(tmp).catch(() => {});
    }
    // 回滚失败的备份不删（它是旧文件唯一副本，已写进抛出的错误）。
    for (const { bak } of backups) {
      if (keepBackups.has(bak)) continue;
      await Deno.remove(bak).catch(() => {});
    }
  }
}
