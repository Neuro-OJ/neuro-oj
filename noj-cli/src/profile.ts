/**
 * profile 概念（#518 P1）。
 *
 * noj-cli 承载两套互不相干的部署模式，但同处一个二进制、同一份 help、同一层命名空间：
 *
 * | profile | 配置来源 | 受众 | 运行环境 |
 * | --- | --- | --- | --- |
 * | `prod`  | `.env.prod` + `docker-compose.prod.yml` | 部署者/运维 | 宿主机（无需 Deno） |
 * | `stack` | `noj-deploy.json` + `noj-secrets.json` | 源码开发者 | 需 Deno |
 *
 * 早先用户无法从界面分清该用哪套：同一个词（`status`/`logs`/`backup`）在
 * **两个深度、两套配置**下含义不同。
 *
 * **设计要点：探测失败必须报错，不得静默选默认值。**
 * 猜错模式会把命令作用到错误的目标（例如对 JSON 编排目录执行生产备份），
 * 代价远高于让用户显式传一次 `--profile`。
 */
import { dirname } from "@std/path";

/** 受支持的 profile。 */
export const PROFILE_NAMES = ["prod"] as const;
export type ProfileName = typeof PROFILE_NAMES[number];

/** 判定来源，供帮助文本与错误信息说明「为什么是这个 profile」。 */
export type ProfileSource =
  | "explicit"
  | "detected"
  | "ambiguous"
  | "none"
  | "invalid";

/** 判定结果。`profile` 为 null 时 `error` 必有值。 */
export interface ProfileDetection {
  profile: ProfileName | null;
  source: ProfileSource;
  error?: string;
}

/** 最小文件系统接口，便于在测试中注入（不触碰真实磁盘）。 */
export interface ProfileFs {
  exists(path: string): boolean;
  isFile(path: string): boolean;
}

/** 判定所需输入。 */
export interface ProfileDetectOptions extends ProfileFs {
  /** `--profile` 显式值。 */
  explicit?: string;
  /** 探测起点（缺省由调用方传 `Deno.cwd()`）。 */
  start: string;
}

/**
 * 生产安装目录特征文件（T5 的唯一事实源）。
 *
 * 只用安装目录必备、且**不随 bash 删除而消失**的文件。早先以
 * `scripts/deploy/production.sh` 为特征，纯 TS 重写删除该脚本后，真实生产目录
 * 会探测失败并按设计报错退出（自锁，spec §3.3 洞 1）。
 *
 * **T12 carry-forward（T5）**：本清单原为模块私有，`production.ts:isInstallDir`
 * 另抄了一份。两处都是"compose + env"这两个名字，但维护上是两份清单。现导出
 * 为唯一事实源：`production.ts` 与 `prod/lifecycle.ts`（T12 的已安装判定）
 * 都必须消费本常量，**不得新增第三份标记清单**。
 */
export const PRODUCTION_MARKERS: readonly string[] = [
  "docker-compose.prod.yml",
  ".env.prod",
];

/** 把路径规整为无尾斜杠形式。 */
function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** 某目录是否为生产安装目录（两个特征文件都在）。 */
function isProductionDir(dir: string, fs: ProfileFs): boolean {
  return PRODUCTION_MARKERS.every((marker) => fs.isFile(joinPath(dir, marker)));
}

/**
 * 判定当前 profile。
 *
 * 优先级（命中即停）：
 * 1. `--profile <name>` 显式给出（T23 起只接受 `prod`）；
 * 2. 目录（或祖先）含 `docker-compose.prod.yml` **且** `.env.prod` → `prod`;
 * 3. 未命中 → 报错（不猜）。
 *
 * **T23**：原先还有 `stack`（`noj-deploy.json` 探测）与"两者同时命中即
 * ambiguous"的分支。该模态删除后，"猜错模式"的风险不复存在——只剩一个模式，
 * 要么识别出生产安装目录，要么明确报错。
 */
export function detectProfile(
  options: ProfileDetectOptions,
): ProfileDetection {
  const { explicit, start, ...fs } = options;

  if (explicit !== undefined) {
    if ((PROFILE_NAMES as readonly string[]).includes(explicit)) {
      return { profile: explicit as ProfileName, source: "explicit" };
    }
    return {
      profile: null,
      source: "invalid",
      error: `无效的 --profile: ${explicit}；可选值: ${
        PROFILE_NAMES.join(" / ")
      }`,
    };
  }

  let dir = start;
  while (true) {
    if (isProductionDir(dir, fs)) {
      return { profile: "prod", source: "detected" };
    }
    const parent = dirname(dir);
    if (parent === dir || parent === "" || parent === ".") break;
    dir = parent;
  }

  return {
    profile: null,
    source: "none",
    error: [
      "未能在当前目录及祖先中识别出生产安装目录",
      `（需要同时含 ${PRODUCTION_MARKERS.join(" 与 ")}）。`,
      "请用 --dir <path> 指向安装目录。",
    ].join("\n"),
  };
}

/** 基于真实文件系统的 {@link ProfileFs} 实现。 */
export function realProfileFs(): ProfileFs {
  const cache = new Map<string, Deno.FileInfo | null>();
  const stat = (path: string): Deno.FileInfo | null => {
    if (!cache.has(path)) {
      try {
        cache.set(path, Deno.statSync(path));
      } catch {
        cache.set(path, null);
      }
    }
    return cache.get(path) ?? null;
  };
  return {
    exists: (path) => stat(path) !== null,
    isFile: (path) => stat(path)?.isFile === true,
  };
}
