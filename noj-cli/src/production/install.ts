/** 生产安装/升级/卸载命令。 */

import type { CommandRunner } from "../runtime/command.ts";
import { realRunner } from "../runtime/command.ts";
import { setProdEnv, validateProdEnv } from "./env.ts";
import { prodComposeArgs, runProdCompose } from "./compose.ts";
import { prodInstallWizard } from "./wizard.ts";

export interface ProdInstallOptions {
  dir: string;
  envFile: string;
  composeFile: string;
  nonInteractive?: boolean;
  dryRun?: boolean;
  downloadOnly?: boolean;
  latest?: boolean;
  version?: string;
  uninstallAll?: boolean;
  yes?: boolean;
  panel?: "auto" | "baota" | "none";
}

interface GithubRelease {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: { name?: string }[];
}

async function latestStableVersion(): Promise<string> {
  const url =
    "https://api.github.com/repos/Neuro-OJ/neuro-oj/releases?per_page=100";
  const res = await fetch(url, {
    headers: {
      "User-Agent": "neuro-oj-updater",
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) throw new Error(`获取 Release 列表失败: HTTP ${res.status}`);
  const releases = (await res.json()) as GithubRelease[];
  const stable = releases.find((r) =>
    !r.draft &&
    !r.prerelease &&
    /^v?\d+\.\d+\.\d+$/.test(r.tag_name ?? "") &&
    r.assets?.some((a) => a.name === "noj-cli-linux-amd64") &&
    r.assets?.some((a) => a.name === "noj-cli-linux-amd64.sha256")
  );
  const tag = stable?.tag_name;
  if (!tag) throw new Error("没有发现资产就绪的正式 Release");
  return tag;
}

export async function prodInstallEnv(
  opts: ProdInstallOptions,
  runner?: CommandRunner,
): Promise<number> {
  const r = runner ?? realRunner();
  const info = await r.run("docker", ["info"]);
  if (info.code !== 0) {
    console.error("install-env: Docker daemon 不可用");
    return 1;
  }
  const compose = await r.run("docker", ["compose", "version"]);
  if (compose.code !== 0) {
    console.error("install-env: Docker Compose v2 不可用");
    return 1;
  }
  void opts;
  console.log("Docker daemon 与 Compose 可用");
  console.log("请确认已准备 rootless Docker socket 等隔离条件");
  return 0;
}

export async function prodInstall(
  opts: ProdInstallOptions,
  runner?: CommandRunner,
): Promise<number> {
  const r = runner ?? realRunner();
  try {
    let envExists = true;
    try {
      Deno.statSync(opts.envFile);
    } catch {
      envExists = false;
    }
    if (!envExists && opts.dryRun) {
      console.log("[dry-run] 将运行首次配置向导");
      return 0;
    }
    if (!envExists) {
      if (opts.nonInteractive) {
        throw new Error("生产配置不存在且为非交互模式，无法引导安装");
      }
      await prodInstallWizard(opts);
    }
    const problems = validateProdEnv(opts.envFile);
    if (problems.length > 0) {
      throw new Error(`生产配置校验失败：${problems.join("; ")}`);
    }
    if (opts.dryRun) {
      console.log("[dry-run] docker compose pull && up -d");
      return 0;
    }
    if (opts.downloadOnly) {
      const pull = await runProdCompose(
        { envFile: opts.envFile, composeFile: opts.composeFile },
        ["pull"],
        r,
      );
      return pull;
    }
    const pull = await runProdCompose(
      { envFile: opts.envFile, composeFile: opts.composeFile },
      ["pull"],
      r,
    );
    if (pull !== 0) return pull;
    return await runProdCompose(
      { envFile: opts.envFile, composeFile: opts.composeFile },
      ["up", "-d", "--remove-orphans"],
      r,
    );
  } catch (e) {
    console.error(`install: ${(e as Error).message}`);
    return 1;
  }
}

export async function prodUpdate(
  opts: ProdInstallOptions,
  runner?: CommandRunner,
): Promise<number> {
  const r = runner ?? realRunner();
  try {
    let targetVersion = opts.version;
    if (opts.latest) {
      targetVersion = await latestStableVersion();
      console.log(`最新稳定版本：${targetVersion}`);
    }
    if (targetVersion !== undefined && !opts.dryRun) {
      setProdEnv(opts.envFile, "NOJ_VERSION", targetVersion);
    }
    if (opts.dryRun) {
      console.log(
        `[dry-run] 将升级到 ${
          targetVersion ?? "当前 NOJ_VERSION"
        } 并执行 pull && up -d`,
      );
      return 0;
    }
    const pull = await runProdCompose(
      { envFile: opts.envFile, composeFile: opts.composeFile },
      ["pull"],
      r,
    );
    if (pull !== 0) return pull;
    return await runProdCompose(
      { envFile: opts.envFile, composeFile: opts.composeFile },
      ["up", "-d", "--remove-orphans"],
      r,
    );
  } catch (e) {
    console.error(`update: ${(e as Error).message}`);
    return 1;
  }
}

function safeRemoveInstallDir(dir: string): void {
  if (dir === "/" || dir === "." || dir === "..") {
    throw new Error("拒绝删除危险安装路径");
  }
  try {
    Deno.statSync(dir);
  } catch {
    return;
  }
  for (const marker of [".git", ".jj"]) {
    try {
      if (Deno.statSync(`${dir}/${marker}`).isDirectory) {
        throw new Error(`检测到 ${marker} 工作区，拒绝删除源码目录`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("检测到")) throw e;
    }
  }
  Deno.removeSync(dir, { recursive: true });
}

export async function prodUninstall(
  opts: ProdInstallOptions,
  runner?: CommandRunner,
): Promise<number> {
  const r = runner ?? realRunner();
  try {
    if (!opts.yes) {
      throw new Error("uninstall 需要 --yes 确认");
    }
    const args = ["down", "--remove-orphans"];
    if (opts.uninstallAll) args.push("--volumes");
    if (opts.dryRun) {
      console.log(`[dry-run] docker compose ${args.join(" ")}`);
      return 0;
    }
    const code = await runProdCompose(
      { envFile: opts.envFile, composeFile: opts.composeFile },
      args,
      r,
    );
    if (code !== 0) return code;
    if (opts.uninstallAll) {
      safeRemoveInstallDir(opts.dir);
      console.log(`已删除安装目录：${opts.dir}`);
    }
    return 0;
  } catch (e) {
    console.error(`uninstall: ${(e as Error).message}`);
    return 1;
  }
}

export function useProdComposeArgsForTesting(
  opts: ProdInstallOptions,
  args: string[],
): string[] {
  return prodComposeArgs(
    { envFile: opts.envFile, composeFile: opts.composeFile },
    args,
  );
}
