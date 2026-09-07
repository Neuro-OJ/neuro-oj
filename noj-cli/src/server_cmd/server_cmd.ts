import { dirname } from "@std/path";
import type { CliContext } from "../context/context.ts";
import { type CommandRunner, realRunner } from "../runtime/command.ts";

export type ServerSubcommand = readonly [string, ...string[]];

export interface ServerCommandOptions {
  context: CliContext;
  args: string[];
  runner?: CommandRunner;
  /** 显式 --dir 指定的源码/部署目录；在 context.dir 为空时作为查找起点。 */
  sourceDir?: string;
}

const VALID_SUBCOMMANDS = new Set([
  "db",
  "init",
  "bootstrap",
  "problems",
  "dev-setup",
]);

function validateArgs(args: string[]): void {
  if (args.length === 0) throw new Error("server: 缺少子命令");
  const [sub, subsub] = args;
  if (!VALID_SUBCOMMANDS.has(sub!)) {
    throw new Error(`server: 未知子命令 ${sub}`);
  }
  if (sub === "bootstrap") {
    const hasPassword = args.some((a) =>
      a === "--password" || a.startsWith("--password=")
    );
    if (hasPassword) {
      throw new Error(
        "server: bootstrap 不接受 --password 命令行参数，请使用交互提示或环境变量",
      );
    }
  }
  if (sub === "dev-setup") {
    if (args.length !== 1) {
      throw new Error("server: dev-setup 不接受额外参数");
    }
    return;
  }
  if (subsub === undefined) {
    if (sub === "db") throw new Error("server: db 需要 migrate");
    if (sub === "init") throw new Error("server: init 需要 system");
    if (sub === "bootstrap") {
      throw new Error("server: bootstrap 需要 first-admin 或 admin");
    }
    if (sub === "problems") {
      throw new Error("server: problems 需要 build 或 import");
    }
  }
  if (sub === "db" && subsub !== "migrate") {
    throw new Error("server: db 需要 migrate");
  }
  if (sub === "init" && subsub !== "system") {
    throw new Error("server: init 需要 system");
  }
  if (sub === "bootstrap" && subsub !== "first-admin" && subsub !== "admin") {
    throw new Error("server: bootstrap 需要 first-admin 或 admin");
  }
  if (sub === "problems" && subsub !== "build" && subsub !== "import") {
    throw new Error("server: problems 需要 build 或 import");
  }
  if ((sub === "db" || sub === "init") && args.length > 2) {
    throw new Error(`server: ${sub} 不接受额外参数`);
  }
}

function findSourceRoot(start: string): string | null {
  let current = start;
  try {
    current = Deno.realPathSync(current);
  } catch {
    return null;
  }
  while (true) {
    try {
      if (Deno.statSync(`${current}/noj-core/deno.json`).isFile) {
        return current;
      }
    } catch {
      // 继续向上
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function sourceCommand(args: string[]): { cmd: string; args: string[] } {
  const [sub, subsub, ...rest] = args;
  if (sub === "db" && subsub === "migrate") {
    return { cmd: "deno", args: ["task", "db:migrate"] };
  }
  if (sub === "init" && subsub === "system") {
    return { cmd: "deno", args: ["task", "init:system"] };
  }
  if (sub === "bootstrap") {
    if (!subsub) throw new Error("server: bootstrap 需要 first-admin 或 admin");
    return {
      cmd: "deno",
      args: [
        "run",
        "--env-file=.env",
        "-A",
        "scripts/noj.ts",
        "bootstrap",
        subsub,
        ...rest,
      ],
    };
  }
  if (sub === "problems") {
    if (subsub === "build") {
      return { cmd: "deno", args: ["task", "problems:build", "--", ...rest] };
    }
    if (subsub === "import") {
      return { cmd: "deno", args: ["task", "problems:import", "--", ...rest] };
    }
  }
  if (sub === "dev-setup") {
    return { cmd: "deno", args: ["task", "dev-setup"] };
  }
  throw new Error(`server: 不支持的源码子命令 ${args.join(" ")}`);
}

export async function runServerCommand(
  opts: ServerCommandOptions,
): Promise<number> {
  const runner = opts.runner ?? realRunner();
  const { context, args } = opts;
  try {
    validateArgs(args);
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }

  if (context.kind === "production" && context.dir !== null) {
    try {
      const fullArgs = [
        "compose",
        "--env-file",
        `${context.dir}/.env.prod`,
        "--file",
        `${context.dir}/docker-compose.prod.yml`,
        "run",
        "--rm",
        "--entrypoint",
        "/app/bin/noj",
        "core",
        ...args,
      ];
      const handle = runner.spawn({
        cmd: "docker",
        args: fullArgs,
        cwd: context.dir,
        env: {},
      });
      return await handle.wait();
    } catch (e) {
      console.error((e as Error).message);
      return 1;
    }
  }

  if (context.kind === "judge") {
    console.error("server: 不适用于 judge 上下文");
    return 1;
  }

  const sourceRoot = findSourceRoot(
    context.dir ?? opts.sourceDir ?? context.cwd,
  );
  if (sourceRoot !== null) {
    try {
      const launch = sourceCommand(args);
      const handle = runner.spawn({
        cmd: launch.cmd,
        args: launch.args,
        cwd: `${sourceRoot}/noj-core`,
        env: {},
      });
      return await handle.wait();
    } catch (e) {
      console.error((e as Error).message);
      return 1;
    }
  }

  console.error("server: 未找到 production 部署或 noj-core 源码目录");
  return 1;
}
