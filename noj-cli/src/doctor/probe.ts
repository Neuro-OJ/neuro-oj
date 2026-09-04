/** 命令执行结果。 */
export interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 内存信息（字节）。 */
export interface MemInfo {
  totalBytes: number;
  swapBytes: number;
}

/** 磁盘信息（字节）。 */
export interface DiskInfo {
  freeBytes: number;
}

/**
 * 系统探针抽象：doctor 的所有检测只通过该接口访问系统，
 * 便于测试注入 fake 实现。
 */
export interface SystemProbe {
  os: string;
  arch: string;
  run(cmd: string, args: string[]): Promise<CmdResult>;
  memInfo(): Promise<MemInfo>;
  diskFree(path: string): Promise<DiskInfo>;
  /** 端口是否被占用（能连上即视为占用）。 */
  portOpen(port: number): Promise<boolean>;
}

/** 解析 /proc/meminfo 中形如 "MemTotal:       16384 kB" 的行，返回字节数。 */
function parseProcMemLine(line: string): number {
  const m = line.match(/:\s*(\d+)\s*kB/);
  if (!m) return 0;
  return Number(m[1]) * 1024;
}

/** 解析 `df -Pk <path>` 输出，返回可用字节数。 */
function parseDfFreeKb(stdout: string): number {
  const lines = stdout.trim().split("\n");
  // 表头后第一行：Filesystem 1024-blocks Used Available Capacity Mounted on
  const row = lines[1];
  if (!row) return 0;
  const parts = row.trim().split(/\s+/);
  // Available 是第 4 列（1-based），单位 KB。
  const kb = Number(parts[3] ?? 0);
  return kb * 1024;
}

/** 构造真实系统探针（仅 linux/amd64 语义；非 linux 时 memInfo/diskFree 返回 0）。 */
export function realProbe(): SystemProbe {
  return {
    os: Deno.build.os,
    arch: Deno.build.arch,
    async run(cmd, args) {
      const p = new Deno.Command(cmd, {
        args,
        stdout: "piped",
        stderr: "piped",
      });
      const out = await p.output();
      return {
        code: out.code,
        stdout: new TextDecoder().decode(out.stdout),
        stderr: new TextDecoder().decode(out.stderr),
      };
    },
    async memInfo() {
      if (Deno.build.os !== "linux") return { totalBytes: 0, swapBytes: 0 };
      const text = await Deno.readTextFile("/proc/meminfo");
      let total = 0;
      let swap = 0;
      for (const line of text.split("\n")) {
        if (line.startsWith("MemTotal:")) total = parseProcMemLine(line);
        if (line.startsWith("SwapTotal:")) swap = parseProcMemLine(line);
      }
      return { totalBytes: total, swapBytes: swap };
    },
    async diskFree(path) {
      const r = await this.run("df", ["-Pk", path]);
      if (r.code !== 0) return { freeBytes: 0 };
      return { freeBytes: parseDfFreeKb(r.stdout) };
    },
    async portOpen(port) {
      try {
        const conn = await Deno.connect({ hostname: "127.0.0.1", port });
        conn.close();
        return true;
      } catch {
        return false;
      }
    },
  };
}
