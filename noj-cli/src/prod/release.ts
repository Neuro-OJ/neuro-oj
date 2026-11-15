/**
 * 生产升级的版本解析与版本配置落盘。
 *
 * - 标签校验：{@link validateReleaseTag}
 * - 最新版本解析：{@link resolveLatestReleaseTag} + {@link releasesApiUrl}
 * - 读当前版本：{@link configuredVersion}
 * - 写版本：{@link writeConfigVersion} / {@link stageConfigVersion} / {@link commitConfigVersion}
 *
 * ## 资产就绪过滤
 *
 * {@link selectLatestAssetReadyRelease} 要求升级会用到的**全部资产**
 * （{@link UPDATE_RELEASE_ASSETS}：CLI + compose + example 及其校验文件）都已就绪：
 * `update` 会以目标 ref 重新拉取 compose/example（`--files-only` 语义），若该 ref
 * 只有二进制而没有部署文件，同步必然失败（issue #431）。
 *
 * ## 版本字符串的口径
 *
 * 解析结果**保留原始 tag 的 `v` 前缀**，写入 `.env.prod` 的也是原文——`NOJ_VERSION` 直接参与镜像
 * tag 插值（`docker-compose.prod.yml` 的 `${NOJ_VERSION}`），改写前缀会让镜像
 * 引用凭空变化。仅 **比较**时归一化前缀（见 {@link normalizedVersion}）。
 *
 * 本模块不持有任何模块级可变状态（AGENTS.md §8.2 多副本约束）：只有常量与纯函数
 * 加文件读写。
 */

import { dirname, join } from "@std/path";
import {
  parseEnvFile,
  serializeEnvFile,
  writeEnvFileAtomic,
} from "../core/env-file.ts";
import { type Fetcher, RELEASE_FILES } from "./bootstrap.ts";

/** GitHub Release 列表条目中本模块需要的字段。 */
interface ReleaseSummary {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name?: string }[];
}

/**
 * Release 标签格式：`v?X.Y.Z`，允许 SemVer 预发布后缀（`-rc.1` / `-beta.3` 等），
 * 与 `prod/judge/config.ts` 的 `VERSION_RE` 一致。
 *
 * **稳定性不由标签后缀判定**：发布流水线先以 GitHub 预发布创建 Release，全部
 * 校验通过后才转正（`prerelease=false`）。因此已转正的 `-rc.N` 同样可被自动选择。
 */
const RELEASE_TAG_RE = /^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * 从 Release 列表里选出**资产就绪**的最新正式版本标签（保留原始 v 前缀）：
 * 合法标签 → 非 draft → 非 prerelease → `assets` 含全部期望资产名。
 * 列表顺序即优先级，命中即返回；无命中返回 `null`。
 */
function selectLatestAssetReadyRelease(
  releases: readonly ReleaseSummary[],
  assets: readonly string[],
): string | null {
  for (const release of releases) {
    const tag = release.tag_name ?? "";
    if (!RELEASE_TAG_RE.test(tag)) continue;
    if (release.draft || release.prerelease) continue;
    const names = new Set((release.assets ?? []).map((asset) => asset.name));
    if (!assets.every((asset) => names.has(asset))) continue;
    return tag;
  }
  return null;
}

/** 升级默认仓库（`NOJ_UPDATE_REPOSITORY` 的缺省值）。 */
export const DEFAULT_UPDATE_REPOSITORY = "https://github.com/Neuro-OJ/neuro-oj";

/**
 * 升级要求**全部就绪**的 Release 资产名。
 *
 * 由 {@link RELEASE_FILES}（compose / example）派生，不手抄第二份清单；
 * 另加 CLI 二进制与其校验文件。
 *
 * 这里比较的是 **Release 资产名**（`asset`）而非落盘文件名（`target`）：
 * `env.prod.example` 资产落盘后叫 `.env.prod.example`，而 Release 上的资产名受
 * GitHub "点号开头会被改写为 `default.<name>`" 约束（见 bootstrap.ts 模块头注释）。
 */
export const UPDATE_RELEASE_ASSETS: readonly string[] = [
  "noj-cli-linux-amd64",
  "noj-cli-linux-amd64.sha256",
  ...RELEASE_FILES.flatMap(({ asset }) => [asset, `${asset}.sha256`]),
  "release-set.json",
  "release-set.json.sha256",
];

/** 稳定版本标签报错文案。 */
export function releaseTagHint(version: string): string {
  return `GitHub Release 标签格式非法：${version}；请使用固定版本升级`;
}

/** 解析最新版本的失败文案。 */
export const UPDATE_API_URL_HINT =
  "无法自动获取最新版本；请使用 NOJ_UPDATE_API_URL 或固定版本升级";

/** API 地址非 HTTPS 的报错文案。 */
export function httpsOnlyHint(url: string): string {
  return `最新版本 API 地址必须使用 HTTPS：${url}`;
}

/** Release 列表获取失败的文案（追加 HTTP 细节便于诊断）。 */
export function releaseListHint(status: number): string {
  return `无法获取 Release 列表，请检查网络，或使用固定版本升级（GitHub API ${status}）`;
}

/** 自定义 API 地址返回的单个 Release 对象无效时的文案。 */
export const SINGLE_RELEASE_INVALID_HINT =
  "GitHub 返回的最新 Release 无效或仍是预发布版本";

/**
 * 校验 Release 标签格式（允许预发布后缀）。
 *
 * 返回原标签（含 `v` 前缀），便于链式使用。
 */
export function validateReleaseTag(tag: string): string {
  if (!RELEASE_TAG_RE.test(tag)) throw new Error(releaseTagHint(tag));
  return tag;
}

/**
 * 版本比较用的归一化形式：去掉前导 `v`（`v0.9.5` 与 `0.9.5` 视为同一版本）。
 *
 * **为什么比较时要归一化**：若逐字比较，`.env.prod` 里写成 `NOJ_VERSION=0.9.5`
 * （合法，历史 Release 有不带 `v` 的 tag：`0.1.0-rc.2`、`v0.9.5` 并存）而最新
 * 稳定 Release 是 `v0.9.5` 时，`--latest` 会认为"有新版"，从而**白跑一次**
 * 备份 + 拉镜像 + 重启全部服务。归一化后该情况正确判定为 no-op。
 *
 * 写入配置时**仍用原始 tag**：`NOJ_VERSION` 直接插入镜像引用，
 * 改写前缀会改变镜像名。
 */
export function normalizedVersion(tag: string): string {
  return tag.replace(/^v/, "");
}

/**
 * 由仓库地址与可选的显式 API 地址推出 Release 列表接口。
 *
 * - `apiUrl` 非空即胜出（`NOJ_UPDATE_API_URL`，供私有镜像/离线验证）；
 * - 否则仓库必须是 `https://github.com/<owner>/<repo>`：**不**用
 *   `/releases/latest`（issue #431：该端点会选中"镜像 / 资产尚未就绪"的版本），
 *   而是取列表接口后在本地过滤；
 * - 任意分支产出的地址都必须是 HTTPS。
 *
 * 仓库末尾的 `.git` 被剥掉：否则会拼出 `/repos/Owner/neuro-oj.git/…` 这个
 * 必然 404 的地址。
 */
export function releasesApiUrl(opts: {
  repository?: string;
  apiUrl?: string;
}): string {
  if (opts.apiUrl !== undefined && opts.apiUrl !== "") {
    if (!opts.apiUrl.startsWith("https://")) {
      throw new Error(httpsOnlyHint(opts.apiUrl));
    }
    return opts.apiUrl;
  }
  const repository = (opts.repository ?? DEFAULT_UPDATE_REPOSITORY)
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(repository);
  if (match === null) {
    throw new Error(UPDATE_API_URL_HINT);
  }
  const url = `https://api.github.com/repos/${match[1]}/releases?per_page=100`;
  // 该分支的地址由上面的常量前缀拼成，恒为 HTTPS；显式断言保住不变式。
  if (!url.startsWith("https://")) throw new Error(httpsOnlyHint(url));
  return url;
}

/**
 * 查询最新**资产就绪**的正式（非 draft、非 prerelease）Release 标签。
 *
 * 两条分支：
 * 1. 列表响应（`[` 开头）：按 {@link UPDATE_RELEASE_ASSETS} 过滤，命中即返回；
 *    无命中报"没有发现资产就绪的正式 Release…"；
 * 2. 单个 Release 对象（自定义 API 地址的常见形态）：要求 `draft`/`prerelease`
 *    **显式为 false**（字段缺失同样拒绝），再过标签格式校验。
 *
 * 网络/HTTP 失败、响应非 JSON 都归到同一条可操作文案；**绝不**回退到
 * `/releases/latest`。
 */
export async function resolveLatestReleaseTag(opts: {
  repository?: string;
  apiUrl?: string;
  fetcher?: Fetcher;
} = {}): Promise<string> {
  const url = releasesApiUrl(opts);
  const fetcher = opts.fetcher ?? ((target: string) => fetch(target));
  const res = await fetcher(url);
  if (!res.ok) throw new Error(releaseListHint(res.status));

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error(releaseListHint(res.status));
  }

  if (Array.isArray(parsed)) {
    const tag = selectLatestAssetReadyRelease(
      parsed as ReleaseSummary[],
      UPDATE_RELEASE_ASSETS,
    );
    if (tag === null) {
      throw new Error(
        "没有发现资产就绪的正式 Release（需要包含 noj-cli 二进制与校验文件），请使用固定版本升级",
      );
    }
    return validateReleaseTag(tag);
  }

  const single = parsed as ReleaseSummary;
  const tag = single.tag_name ?? "";
  if (tag === "" || single.draft !== false || single.prerelease !== false) {
    throw new Error(SINGLE_RELEASE_INVALID_HINT);
  }
  return validateReleaseTag(tag);
}

// ---------------- 版本配置的读写 ----------------

/** `.env.prod` 缺失文案。 */
export function envMissingHint(envFile: string): string {
  return `未找到生产配置：${envFile}`;
}

/** `.env.prod` 缺少 `NOJ_VERSION` 文案。 */
export function versionMissingHint(envFile: string): string {
  return `生产配置缺少 NOJ_VERSION：${envFile}`;
}

/**
 * 读 `.env.prod` 的 `NOJ_VERSION`。
 *
 * 先判文件存在（`未找到生产配置`），再取值；取到后剥一层成对引号
 * （{@link parseEnvFile} 已实现同一语义），空值即报 `生产配置缺少 NOJ_VERSION`。
 * 原样返回（**不去 `v` 前缀**）：它既用于比较，也是 compose 的镜像 tag 插值源。
 */
export async function configuredVersion(envFile: string): Promise<string> {
  let text: string;
  try {
    text = await Deno.readTextFile(envFile);
  } catch {
    throw new Error(envMissingHint(envFile));
  }
  // 复用 parseEnvFile：首个 `^NOJ_VERSION=` 命中即胜出、成对引号剥一层、CRLF 归一。
  // 不用 `readEnvFile`：它的"文件不存在"文案是另一套，这里必须先报
  // `未找到生产配置`，故自行读取、只复用解析。
  const version = parseEnvFile(text).get("NOJ_VERSION") ?? "";
  if (version === "") throw new Error(versionMissingHint(envFile));
  return version;
}

/**
 * 生成**仅改动 `NOJ_VERSION`** 的配置文本。
 *
 * 委托 {@link serializeEnvFile}：命中 `^NOJ_VERSION=` 的行就地替换（值相同
 * 则逐字节保留原行），其余行（注释、空行、其它键、顺序）原样保留；原文本没有该
 * 键时追加到末尾。因此"注释与顺序保留 + 幂等写回"由 env-file 的既有测试背书，本模块不另写一套序列化。
 */
export function versionConfigText(original: string, version: string): string {
  return serializeEnvFile(new Map([["NOJ_VERSION", version]]), original);
}

/**
 * 把 `version` 落进 `.env.prod`。
 *
 * 原子写（临时文件 → 600 → rename）由 {@link writeEnvFileAtomic} 保证。
 */
export async function writeConfigVersion(
  envFile: string,
  version: string,
): Promise<void> {
  await writeEnvFileAtomic(envFile, new Map([["NOJ_VERSION", version]]));
}

/**
 * 把新版本写进**暂存文件**并返回其路径。
 *
 * 语义：
 * 内容 = 原配置（逐字节保留注释/顺序/其它键）仅把 `NOJ_VERSION` 换成新值；
 * 权限 600；同名目录内落盘，便于成功后用 `rename` 原子提交。
 *
 * 暂存文件放在 `.env.prod` **同目录**：跨目录 `rename` 可能退化为拷贝并丢失原子性。
 */
export async function stageConfigVersion(
  envFile: string,
  version: string,
): Promise<string> {
  let original: string;
  try {
    original = await Deno.readTextFile(envFile);
  } catch {
    throw new Error(envMissingHint(envFile));
  }
  const staged = join(
    dirname(envFile),
    `.env.prod.latest.${Deno.pid}.${crypto.randomUUID()}`,
  );
  const text = versionConfigText(original, version);
  try {
    const file = await Deno.open(staged, {
      create: true,
      write: true,
      truncate: true,
      mode: 0o600,
    });
    try {
      await file.write(new TextEncoder().encode(text));
    } finally {
      file.close();
    }
    // open 的 mode 会被 umask 裁剪，暂存文件必须恒为 600。
    await Deno.chmod(staged, 0o600);
  } catch (err) {
    await Deno.remove(staged).catch(() => {});
    throw new Error(`无法创建版本配置暂存文件：${staged}`, { cause: err });
  }
  return staged;
}

/**
 * 提交暂存配置：`chmod 600` + 原子 `rename` 覆盖 `.env.prod`。
 *
 * 失败文案 `升级成功但无法提交生产版本配置`——此时服务**已经**
 * 升到新版本，但配置仍指向旧值，属于必须显式告知的半完成状态。
 *
 * 提交失败时**保留**暂存文件：它内含用户
 * 配置的唯一新副本，删除会丢掉"应该写什么"的信息。
 */
export async function commitConfigVersion(
  staged: string,
  envFile: string,
): Promise<void> {
  try {
    await Deno.chmod(staged, 0o600);
    await Deno.rename(staged, envFile);
  } catch (err) {
    throw new Error(
      `升级成功但无法提交生产版本配置：${envFile}（新配置仍在 ${staged}）`,
      { cause: err },
    );
  }
}
