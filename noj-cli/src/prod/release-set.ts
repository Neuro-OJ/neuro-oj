/**
 * 生产发布集合同（P8）。
 *
 * Release tag、部署文件、镜像 digest、协议版本和 SDK 标准必须作为一个不可变
 * 对象交付。安装/升级只接受经过 SHA-256 校验且与目标 tag 一致的 release-set，
 * 不再把「能拉到几个镜像」误当成发布完整。
 */

import { validateReleaseTag } from "./release.ts";
import type { VerifiedDigest } from "./config.ts";
import wasmStandard from "../../../noj-core/src/modules/problems/types/noj-wasm-v3.json" with {
  type: "json",
};

export const RELEASE_SET_ASSET = "release-set.json";
export const RELEASE_SET_SHA_ASSET = `${RELEASE_SET_ASSET}.sha256`;
export const RELEASE_SET_SCHEMA_VERSION = 1 as const;
export const EVALUATION_PROTOCOL_VERSION = 3 as const;
export const GATEWAY_PROTOCOL_VERSION = 3 as const;
// 与 Core 实际内置标准共用构建输入，避免生成器与校验器一起接受旧常量。
export const SDK_STANDARD = wasmStandard.id;

export const RELEASE_SET_COMPONENTS = [
  "core",
  "ui",
  "judge",
  "gateway",
  "evaluator",
  "solution",
  "solution_ai",
] as const;

export type ReleaseSetComponentName = (typeof RELEASE_SET_COMPONENTS)[number];

export interface ReleaseSetComponent {
  image: string;
  digest: string;
}

export interface ReleaseSet {
  schema_version: typeof RELEASE_SET_SCHEMA_VERSION;
  release: string;
  migration_level: string;
  protocol_versions: {
    evaluation: typeof EVALUATION_PROTOCOL_VERSION;
    gateway: typeof GATEWAY_PROTOCOL_VERSION;
  };
  components: Record<ReleaseSetComponentName, ReleaseSetComponent>;
  cli_version: string;
  ide_version: string;
  sdk_standard: typeof SDK_STANDARD;
}

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const IMAGE_RE = /^[^\s@]+$/;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`发布集 ${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`发布集 ${label}.${key} 必须是非空字符串`);
  }
  return value;
}

function protocolVersion(
  record: Record<string, unknown>,
  key: "evaluation" | "gateway",
): 3 {
  if (record[key] !== 3) {
    throw new Error(`发布集 protocol_versions.${key} 必须为 3`);
  }
  return 3;
}

/** 校验并返回可安全消费的发布集；可传 expectedRelease 做目标 tag 绑定。 */
export function validateReleaseSet(
  value: unknown,
  expectedRelease?: string,
): ReleaseSet {
  const root = asRecord(value, "根");
  if (root.schema_version !== RELEASE_SET_SCHEMA_VERSION) {
    throw new Error(
      `发布集 schema_version 必须为 ${RELEASE_SET_SCHEMA_VERSION}`,
    );
  }
  const release = validateReleaseTag(requiredString(root, "release", "根"));
  if (
    expectedRelease !== undefined &&
    release.replace(/^v/, "") !== expectedRelease.replace(/^v/, "")
  ) {
    throw new Error(
      `发布集版本 ${release} 与目标版本 ${expectedRelease} 不一致`,
    );
  }
  const migrationLevel = requiredString(root, "migration_level", "根");
  const protocol = asRecord(root.protocol_versions, "protocol_versions");
  const components = asRecord(root.components, "components") as Record<
    string,
    unknown
  >;
  const normalizedComponents = {} as Record<
    ReleaseSetComponentName,
    ReleaseSetComponent
  >;
  for (const name of RELEASE_SET_COMPONENTS) {
    const component = asRecord(components[name], `components.${name}`);
    const image = requiredString(component, "image", `components.${name}`);
    const digest = requiredString(component, "digest", `components.${name}`);
    if (!IMAGE_RE.test(image)) {
      throw new Error(`发布集 components.${name}.image 含非法空白或 digest`);
    }
    if (!DIGEST_RE.test(digest)) {
      throw new Error(
        `发布集 components.${name}.digest 必须是 sha256:<64 位十六进制>`,
      );
    }
    normalizedComponents[name] = { image, digest };
  }
  const cliVersion = validateReleaseTag(
    requiredString(root, "cli_version", "根"),
  );
  const ideVersion = validateReleaseTag(
    requiredString(root, "ide_version", "根"),
  );
  if (cliVersion.replace(/^v/, "") !== release.replace(/^v/, "")) {
    throw new Error(
      `发布集 cli_version ${cliVersion} 与 release ${release} 不一致`,
    );
  }
  if (ideVersion.replace(/^v/, "") !== release.replace(/^v/, "")) {
    throw new Error(
      `发布集 ide_version ${ideVersion} 与 release ${release} 不一致`,
    );
  }
  if (root.sdk_standard !== SDK_STANDARD) {
    throw new Error(`发布集 sdk_standard 必须为 ${SDK_STANDARD}`);
  }
  return {
    schema_version: RELEASE_SET_SCHEMA_VERSION,
    release,
    migration_level: migrationLevel,
    protocol_versions: {
      evaluation: protocolVersion(protocol, "evaluation"),
      gateway: protocolVersion(protocol, "gateway"),
    },
    components: normalizedComponents,
    cli_version: cliVersion,
    ide_version: ideVersion,
    sdk_standard: SDK_STANDARD,
  };
}

/** 从已校验的 release-set 文件读取并绑定目标版本。 */
export async function readReleaseSet(
  path: string,
  expectedRelease?: string,
): Promise<ReleaseSet> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    throw new Error(`无法读取发布集：${path}（${(error as Error).message}）`, {
      cause: error,
    });
  }
  return validateReleaseSet(parsed, expectedRelease);
}

export const RELEASE_SET_COMPONENT_IMAGES: Record<
  ReleaseSetComponentName,
  string
> = {
  core: "ghcr.io/neuro-oj/noj-server",
  ui: "ghcr.io/neuro-oj/noj-ui",
  judge: "ghcr.io/neuro-oj/noj-judge",
  gateway: "ghcr.io/neuro-oj/noj-llm-gateway",
  evaluator: "ghcr.io/neuro-oj/noj-evaluator-python",
  solution: "ghcr.io/neuro-oj/noj-solution-python",
  solution_ai: "ghcr.io/neuro-oj/noj-solution-ai",
};

const RELEASE_SET_COMPONENT_IMAGE_NAMES: Record<
  ReleaseSetComponentName,
  string
> = {
  core: "noj-server",
  ui: "noj-ui",
  judge: "noj-judge",
  gateway: "noj-llm-gateway",
  evaluator: "noj-evaluator-python",
  solution: "noj-solution-python",
  solution_ai: "noj-solution-ai",
};

function imageRepository(image: string): string {
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  return colon > slash ? image.slice(0, colon) : image;
}

/** 将签名校验返回的镜像 digest 与发布集逐项对照。 */
export function releaseSetDigestMismatches(
  releaseSet: ReleaseSet,
  verified: readonly VerifiedDigest[],
  judgeEnabled: boolean,
): string[] {
  const expectedNames = judgeEnabled
    ? RELEASE_SET_COMPONENTS
    : (["core", "ui", "gateway"] as const);
  const mismatches: string[] = [];
  for (const component of expectedNames) {
    const imageName = RELEASE_SET_COMPONENT_IMAGE_NAMES[component];
    const actualEntry = verified.find((entry) => entry.name === imageName);
    const actual = actualEntry?.digest;
    if (actual === undefined) {
      mismatches.push(`${component} 缺少验签 digest`);
    } else if (
      actual !== releaseSet.components[component].digest ||
      imageRepository(actualEntry!.image) !==
        releaseSet.components[component].image
    ) {
      mismatches.push(
        `${component} 镜像或 digest 不一致：发布集 ${
          releaseSet.components[component].image
        }@${releaseSet.components[component].digest}，实际 ${
          actualEntry!.image
        }@${actual}`,
      );
    }
  }
  return mismatches;
}
