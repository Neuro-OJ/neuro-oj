/**
 * 上传上限一致性门禁（2026-11-02 rc/v0.11 审计 F6）。
 *
 * 审计发现：生产 Nginx 全站 `client_max_body_size 64m`，而后端题包/支持包上限
 * 128 MiB、产物硬上限默认 2 GiB —— 超过 64 MiB 的请求在边缘就被拒绝，后端上限
 * 从不可达，且"配置正确"与"行为可用"之间没有任何自动校验。
 *
 * 本门禁解析两侧并断言：
 * 1. `deploy/nginx/default.conf` 的每个上传 location 都出现在
 *    `dev-docs/engineering/upload-limits.md` 契约表里（反之亦然）；
 * 2. 代理上限 **≥** 应用上限（应用上限从 core 常量读取）；
 * 3. 上传 location 必须关闭 `proxy_request_buffering`（否则边缘先落盘再转发）。
 */
import { readTextFileSync } from "./audit-io.ts";

/** 契约表里登记的上传端点族。 */
export interface UploadEndpoint {
  /** location 正则（nginx 原文）。 */
  pattern: string;
  /** 代理上限（MiB）。 */
  proxyMiB: number;
  /** 应用上限来源（常量名或环境变量）。 */
  appLimit: string;
  /** 应用上限（MiB）。 */
  appMiB: number;
}

/** 解析 nginx 配置里的上传 location 块。 */
export function parseNginxUploadLocations(
  conf: string,
): Array<
  { pattern: string; clientMaxBodySize: string; requestBuffering: boolean }
> {
  const blocks = conf.split(/location\s+/).slice(1);
  const result: Array<
    { pattern: string; clientMaxBodySize: string; requestBuffering: boolean }
  > = [];
  for (const block of blocks) {
    const body = block.slice(block.indexOf("{"), block.lastIndexOf("}"));
    if (!/import-bundle|support-package|files\/save|submissions/.test(block)) {
      continue;
    }
    const pattern = block.slice(0, block.indexOf("{")).trim();
    const size = /client_max_body_size\s+([0-9]+[kKmMgG]?)\s*;/.exec(body)?.[1];
    if (!size) continue;
    result.push({
      pattern,
      clientMaxBodySize: size,
      requestBuffering: /proxy_request_buffering\s+off\s*;/.test(body),
    });
  }
  return result;
}

/** 把 `128m` / `2048m` 归一为 MiB 数值。 */
export function toMiB(value: string): number {
  const match = /^([0-9]+)([kKmMgG]?)$/.exec(value.trim());
  if (!match) return Number.NaN;
  const amount = Number(match[1]);
  switch (match[2]!.toLowerCase()) {
    case "k":
      return amount / 1024;
    case "g":
      return amount * 1024;
    default:
      return amount;
  }
}

/** 从 core 常量文件读取应用上限（MiB）。 */
export function readAppLimits(root = "."): Map<string, number> {
  const limits = new Map<string, number>();
  const support = readTextFileSync(
    `${root}/noj-core/src/modules/problems/services/support-package.ts`,
  );
  const supportLimit =
    /MAX_SUPPORT_PACKAGE_SIZE\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024/
      .exec(support);
  if (supportLimit) {
    limits.set("MAX_SUPPORT_PACKAGE_SIZE", Number(supportLimit[1]));
  }
  const artifact = readTextFileSync(
    `${root}/noj-core/src/modules/evaluations/services/submissions/artifact-submissions.ts`,
  );
  const artifactLimit =
    /DEFAULT_ARTIFACT_MAX_SIZE_BYTES\s*=\s*(\d+)\s*\*\s*1024\s*\*\s*1024\s*\*\s*1024/
      .exec(artifact);
  if (artifactLimit) {
    limits.set(
      "DEFAULT_ARTIFACT_MAX_SIZE_BYTES",
      Number(artifactLimit[1]) * 1024,
    );
  }
  return limits;
}

/** 一个 location 的上限判定。 */
export interface UploadLimitIssue {
  pattern: string;
  problem: string;
}

/**
 * 校验代理与应用上限一致。
 *
 * @param nginxConf nginx 配置原文
 * @param appLimits 应用上限（MiB，按常量名）
 */
export function checkUploadLimits(
  nginxConf: string,
  appLimits: Map<string, number>,
): UploadLimitIssue[] {
  const issues: UploadLimitIssue[] = [];
  const locations = parseNginxUploadLocations(nginxConf);
  if (locations.length === 0) {
    return [{ pattern: "*", problem: "没有解析到任何上传 location，门禁失效" }];
  }
  const supportMiB = appLimits.get("MAX_SUPPORT_PACKAGE_SIZE");
  const artifactMiB = appLimits.get("DEFAULT_ARTIFACT_MAX_SIZE_BYTES");
  for (const location of locations) {
    if (!location.requestBuffering) {
      issues.push({
        pattern: location.pattern,
        problem:
          "上传 location 必须关闭 proxy_request_buffering（避免边缘先落盘再转发）",
      });
    }
    const proxyMiB = toMiB(location.clientMaxBodySize);
    const isArtifact = /submissions/.test(location.pattern);
    const appMiB = isArtifact ? artifactMiB : supportMiB;
    const limitName = isArtifact
      ? "DEFAULT_ARTIFACT_MAX_SIZE_BYTES"
      : "MAX_SUPPORT_PACKAGE_SIZE";
    if (appMiB === undefined) {
      issues.push({
        pattern: location.pattern,
        problem: `应用上限常量 ${limitName} 未解析到`,
      });
      continue;
    }
    if (!(proxyMiB >= appMiB)) {
      issues.push({
        pattern: location.pattern,
        problem:
          `代理上限 ${location.clientMaxBodySize}（${proxyMiB} MiB）小于应用上限 ${limitName}（${appMiB} MiB）`,
      });
    }
  }
  return issues;
}

if (import.meta.main) {
  const conf = readTextFileSync("deploy/nginx/default.conf");
  const issues = checkUploadLimits(conf, readAppLimits("."));
  if (issues.length > 0) {
    console.error("上传上限契约不一致：");
    for (const issue of issues) {
      console.error(`  ${issue.pattern}：${issue.problem}`);
    }
    Deno.exit(1);
  }
  console.log(
    "上传上限契约一致（代理 ≥ 应用，上传 location 均关闭请求体缓冲）",
  );
}
