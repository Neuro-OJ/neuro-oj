/** 命令执行结果。 */
export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** spawn 进程的参数。 */
export interface SpawnOpts {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** 已启动进程的句柄：记录 PID，可等待退出或终止。 */
export interface SpawnHandle {
  pid: number;
  /** 等待进程退出，返回退出码。 */
  wait(): Promise<number>;
  /** 发送 SIGTERM 终止进程（失败静默）。 */
  kill(): Promise<void>;
}

/**
 * 系统命令/进程抽象：deploy 的所有 docker 调用与进程管理只经该接口，
 * 便于测试注入 fake 模拟 docker / process。
 */
export interface CommandRunner {
  run(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<CmdResult>;
  spawn(opts: SpawnOpts): SpawnHandle;
}

/** 真实实现：`Deno.Command` 的 run 与 spawn。 */
export function realRunner(): CommandRunner {
  const decoder = new TextDecoder();
  return {
    async run(cmd, args, opts) {
      const p = new Deno.Command(cmd, {
        args,
        cwd: opts?.cwd,
        env: opts?.env ?? {},
        stdout: "piped",
        stderr: "piped",
      });
      const out = await p.output();
      return {
        code: out.code,
        stdout: decoder.decode(out.stdout),
        stderr: decoder.decode(out.stderr),
      };
    },
    spawn(opts) {
      const child = new Deno.Command(opts.cmd, {
        args: opts.args,
        cwd: opts.cwd,
        env: opts.env,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      return {
        pid: child.pid,
        async wait() {
          const status = await child.status;
          return status.code;
        },
        kill() {
          try {
            child.kill("SIGTERM");
          } catch {
            // 已退出则忽略
          }
          return Promise.resolve();
        },
      };
    },
  };
}
