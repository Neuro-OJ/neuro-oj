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
  /** 存在时把子进程 stdout 追加写入该文件。 */
  stdoutFile?: string;
  /** 存在时把子进程 stderr 追加写入该文件。 */
  stderrFile?: string;
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
    opts?: { cwd?: string; env?: Record<string, string>; stdin?: string },
  ): Promise<CmdResult>;
  spawn(opts: SpawnOpts): SpawnHandle;
  /** 逐行流式执行命令；onLine 每收到一行（不含换行）回调一次，返回退出码。可选：P2 既有 fake 可不实现。 */
  stream?(
    cmd: string,
    args: string[],
    onLine: (line: string) => void,
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<number>;
}

/** 真实实现：`Deno.Command` 的 run 与 spawn。 */
export function realRunner(): CommandRunner {
  const decoder = new TextDecoder();
  return {
    async run(cmd, args, opts) {
      const stdin = opts?.stdin;
      if (stdin === undefined) {
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
      }
      const p = new Deno.Command(cmd, {
        args,
        cwd: opts?.cwd,
        env: opts?.env ?? {},
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      });
      const child = p.spawn();
      const writer = child.stdin.getWriter();
      await writer.write(new TextEncoder().encode(stdin));
      await writer.close();
      const [status, stdoutBuf, stderrBuf] = await Promise.all([
        child.status,
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).arrayBuffer(),
      ]);
      return {
        code: status.code,
        stdout: decoder.decode(stdoutBuf),
        stderr: decoder.decode(stderrBuf),
      };
    },
    spawn(opts) {
      const cmd = new Deno.Command(opts.cmd, {
        args: opts.args,
        cwd: opts.cwd,
        env: opts.env,
        stdout: opts.stdoutFile ? "piped" : "inherit",
        stderr: opts.stderrFile ? "piped" : "inherit",
      });
      const child = cmd.spawn();
      const pipes: Promise<void>[] = [];
      if (opts.stdoutFile) {
        const f = Deno.open(opts.stdoutFile, {
          write: true,
          create: true,
          append: true,
        });
        pipes.push(f.then((file) => child.stdout.pipeTo(file.writable)));
      }
      if (opts.stderrFile) {
        const f = Deno.open(opts.stderrFile, {
          write: true,
          create: true,
          append: true,
        });
        pipes.push(f.then((file) => child.stderr.pipeTo(file.writable)));
      }
      return {
        pid: child.pid,
        async wait() {
          const code = (await child.status).code;
          await Promise.allSettled(pipes);
          return code;
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
    async stream(cmd, args, onLine, opts) {
      const p = new Deno.Command(cmd, {
        args,
        cwd: opts?.cwd,
        env: opts?.env,
        stdout: "piped",
        stderr: "piped",
      });
      const child = p.spawn();
      let buf = "";
      const reader = child.stdout.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (line.endsWith("\r")) onLine(line.slice(0, -1));
          else onLine(line);
        }
      }
      if (buf.length > 0) onLine(buf);
      return (await child.status).code;
    },
  };
}
