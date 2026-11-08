/**
 * 镜像签名校验（cosign）与部署元数据记录。
 */

import { join } from "@std/path";
import type { CommandRunner } from "../../runtime/command.ts";
import { type EnvValues, judgeEnabledFrom } from "./checks.ts";

/** 默认镜像仓库（compose 文件里的 `${NOJ_IMAGE_REGISTRY:-...}`）。 */
export const DEFAULT_IMAGE_REGISTRY = "ghcr.io/neuro-oj";

/** 默认 cosign 证书身份正则（deploy.sh:851）。 */
export const DEFAULT_COSIGN_IDENTITY_REGEX =
  "^https://github.com/Neuro-OJ/neuro-oj/.github/workflows/release.yml@.*$";

/** cosign OIDC issuer（deploy.sh:867）。 */
export const DEFAULT_COSIGN_OIDC_ISSUER =
  "https://token.actions.githubusercontent.com";

/** 无条件校验的生产镜像（deploy.sh:854）。 */
export const PROD_IMAGES: readonly string[] = [
  "noj-server",
  "noj-ui",
  "noj-llm-gateway",
];
/** judge 启用时追加的镜像（deploy.sh:856）。 */
export const JUDGE_IMAGES: readonly string[] = [
  "noj-judge",
  "noj-evaluator-python",
  "noj-solution-python",
  "noj-solution-ai",
];

/** 已验签的镜像 digest 记录（亦为 `record_deployment_metadata` 的输入）。 */
export interface VerifiedDigest {
  /** 完整镜像引用（含 tag）。 */
  image: string;
  /** 镜像短名（写入部署元数据）。 */
  name: string;
  /** `sha256:<64 hex>`。 */
  digest: string;
}

/** {@link verifyImageSignatures} 的注入点。 */
export interface VerifyImageOptions {
  runner: CommandRunner;
  /** cosign 是否可用（`command -v cosign` 的等价注入）。缺省视为可用。 */
  cosignAvailable?: () => Promise<boolean>;
  /** docker 可执行名（`NOJ_DEPLOY_DOCKER_BIN` 的等价）。 */
  dockerBin?: string;
  /** cosign 可执行名。 */
  cosignBin?: string;
  /** 告警汇聚点（关闭验签时提示）。 */
  warn?: (message: string) => void;
}

/** {@link verifyImageSignatures} 结果。 */
export interface VerifyImageResult {
  ok: boolean;
  /** `NOJ_ENFORCE_IMAGE_SIGNATURES=false` 时为 true（未执行任何命令）。 */
  skipped: boolean;
  error: string | null;
  /** 已通过验签的镜像（失败时只含失败前已通过的）。 */
  digests: VerifiedDigest[];
}

/** 从 `buildx imagetools inspect` 输出取 digest（对应 awk '/^Digest:/ {print $2}'）。 */
export function parseDigest(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const match = /^Digest:\s+(\S+)/.exec(line);
    if (match !== null) {
      return /^sha256:[0-9a-f]{64}$/.test(match[1] ?? "") ? match[1]! : null;
    }
  }
  return null;
}

/**
 * 迁移 `verify_image_signatures`（:837-874）。
 *
 * - `NOJ_ENFORCE_IMAGE_SIGNATURES=false` → 跳过（零调用）；
 * - cosign 不可用 → 报错返回（零调用）；
 * - 逐镜像：`docker buildx imagetools inspect` 取 digest → `cosign verify`
 *   校验身份正则与 OIDC issuer；任一失败即返回其错误。
 *
 * 所有命令都经注入 runner；`command -v cosign` 以注入的 `cosignAvailable` 替代。
 */
export async function verifyImageSignatures(
  env: EnvValues,
  opts: VerifyImageOptions,
): Promise<VerifyImageResult> {
  if ((env["NOJ_ENFORCE_IMAGE_SIGNATURES"] ?? "") === "false") {
    opts.warn?.("NOJ_ENFORCE_IMAGE_SIGNATURES=false，已关闭镜像签名校验");
    return { ok: true, skipped: true, error: null, digests: [] };
  }

  const dockerBin = opts.dockerBin ?? "docker";
  const cosignBin = opts.cosignBin ?? "cosign";
  const cosignAvailable = opts.cosignAvailable ??
    (() => Promise.resolve(true));
  if (!(await cosignAvailable())) {
    return {
      ok: false,
      skipped: false,
      error:
        "已开启镜像签名校验，但找不到 Cosign；请先安装 Cosign，或将 NOJ_ENFORCE_IMAGE_SIGNATURES 设置为 false",
      digests: [],
    };
  }

  const version = env["NOJ_VERSION"] ?? "";
  const registry = env["NOJ_IMAGE_REGISTRY"] || DEFAULT_IMAGE_REGISTRY;
  const identity = env["NOJ_COSIGN_CERT_IDENTITY_REGEX"] ||
    DEFAULT_COSIGN_IDENTITY_REGEX;
  const images = judgeEnabledFrom(env)
    ? [...PROD_IMAGES, ...JUDGE_IMAGES]
    : [...PROD_IMAGES];

  const digests: VerifiedDigest[] = [];
  for (const name of images) {
    const image = `${registry}/${name}:${version}`;
    const inspect = await opts.runner.run(dockerBin, [
      "buildx",
      "imagetools",
      "inspect",
      image,
    ]);
    const digest = parseDigest(inspect.stdout);
    if (digest === null) {
      return {
        ok: false,
        skipped: false,
        error: `无法解析生产镜像 digest：${image}`,
        digests,
      };
    }

    const ref = `${image}@${digest}`;
    const verify = await opts.runner.run(cosignBin, [
      "verify",
      "--certificate-identity-regexp",
      identity,
      "--certificate-oidc-issuer",
      DEFAULT_COSIGN_OIDC_ISSUER,
      ref,
    ]);
    if (verify.code !== 0) {
      return {
        ok: false,
        skipped: false,
        error: `生产镜像 Cosign 签名校验失败：${ref}`,
        digests,
      };
    }
    digests.push({ image, name, digest });
  }

  return { ok: true, skipped: false, error: null, digests };
}

// ---------------- 部署元数据 ----------------

/** 部署元数据文件名（deploy.sh:881）。 */
export const DEPLOYMENT_MANIFEST_FILE = "current-deployment.txt";

/** {@link recordDeploymentMetadata} 的输入。 */
export interface RecordMetadataOptions {
  version: string;
  at: Date;
  verified: VerifiedDigest[];
  backupDir: string;
  fileName?: string;
}

/** {@link recordDeploymentMetadata} 结果。 */
export interface RecordMetadataResult {
  written: boolean;
  path: string | null;
}

/**
 * 迁移 `record_deployment_metadata`（:875-891）。
 *
 * 无验签结果时不产生任何副作用（bash 的 `return 0`）；否则在 `backupDir` 下
 * 原子写出 `current-deployment.txt`（权限 600），内容为
 * `version=` / `recorded_at=` / 排序后的 `<name> <digest>` 行。
 */
export async function recordDeploymentMetadata(
  opts: RecordMetadataOptions,
): Promise<RecordMetadataResult> {
  if (opts.verified.length === 0) return { written: false, path: null };

  await Deno.mkdir(opts.backupDir, { recursive: true });
  const manifest = join(
    opts.backupDir,
    opts.fileName ?? DEPLOYMENT_MANIFEST_FILE,
  );
  const recordedAt = opts.at.toISOString().replace(/\.\d{3}Z$/, "Z");
  const digestLines = opts.verified
    .map((entry) => `${entry.name} ${entry.digest}`)
    .sort();
  const text = `version=${opts.version}\nrecorded_at=${recordedAt}\n${
    digestLines.join("\n")
  }\n`;

  const tmp = join(
    opts.backupDir,
    `.current-deployment.${Deno.pid}.${crypto.randomUUID()}`,
  );
  try {
    const file = await Deno.open(tmp, {
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
    await Deno.chmod(tmp, 0o600);
    await Deno.rename(tmp, manifest);
  } catch (err) {
    try {
      await Deno.remove(tmp);
    } catch {
      // 清理失败不覆盖原始错误
    }
    throw err;
  }
  return { written: true, path: manifest };
}
