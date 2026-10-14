/** 交互输入输出抽象：真实实现走终端，测试注入 fake。 */
export interface PromptIO {
  write(text: string): void;
  readLine(prompt: string): Promise<string>;
  /** 敏感输入，不回显。 */
  readSecret(prompt: string): Promise<string>;
}

/** 构造真实终端 IO。 */
export function realIO(): PromptIO {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let pending = "";
  return {
    write(text) {
      Deno.stdout.writeSync(encoder.encode(text));
    },
    async readLine(prompt) {
      this.write(prompt);
      for (;;) {
        const idx = pending.indexOf("\n");
        if (idx !== -1) {
          const line = pending.slice(0, idx);
          pending = pending.slice(idx + 1);
          return line.replace(/\r$/, "");
        }
        const buf = new Uint8Array(1024);
        const n = await Deno.stdin.read(buf);
        if (n === null) {
          const line = pending;
          pending = "";
          return line;
        }
        pending += decoder.decode(buf.subarray(0, n));
      }
    },
    async readSecret(prompt) {
      this.write(prompt);
      // 非终端（管道 / 重定向）：按行读取，与 readLine 共用缓冲
      if (!Deno.stdin.isTerminal()) return await this.readLine("");
      Deno.stdin.setRaw(true);
      try {
        return await collectSecret((buf) => Deno.stdin.read(buf));
      } finally {
        Deno.stdin.setRaw(false);
        this.write("\n");
      }
    },
  };
}

/**
 * 在原始模式（raw mode）下逐键收集一行敏感输入，直到回车。
 *
 * 原始模式下每次 `read` 只返回当前已按下的键（通常一次一个），必须循环读到回车；
 * 此前只读一次就返回，密码只取到第一个字符，其余按键在进程退出后**泄漏给 shell**
 * 被当成命令执行（明文进入终端与 shell 历史）。
 *
 * 处理：回车/换行结束；Backspace 删除一个字符（按 UTF-8 回退）；Ctrl-C 取消；
 * Ctrl-D 在空输入时结束；跳过方向键、括号粘贴标记等 ESC 序列与其他控制字符。
 */
export async function collectSecret(
  read: (buf: Uint8Array) => Promise<number | null>,
): Promise<string> {
  const bytes: number[] = [];
  const buf = new Uint8Array(256);
  const done = () => new TextDecoder().decode(new Uint8Array(bytes));
  let escape: "none" | "start" | "csi" = "none";
  for (;;) {
    const n = await read(buf);
    if (n === null) return done();
    for (let i = 0; i < n; i++) {
      const b = buf[i]!;
      if (escape === "start") {
        escape = b === 0x5b ? "csi" : "none"; // ESC [ … 进入 CSI，其余为两字节序列
        continue;
      }
      if (escape === "csi") {
        if (b >= 0x40 && b <= 0x7e) escape = "none"; // CSI 终止字节
        continue;
      }
      if (b === 0x0d || b === 0x0a) return done();
      if (b === 0x03) throw new Error("已取消");
      if (b === 0x04) {
        if (bytes.length === 0) return "";
        continue;
      }
      if (b === 0x7f || b === 0x08) {
        while (bytes.length > 0 && (bytes[bytes.length - 1]! & 0xc0) === 0x80) {
          bytes.pop();
        }
        bytes.pop();
        continue;
      }
      if (b === 0x1b) {
        escape = "start";
        continue;
      }
      if (b < 0x20) continue;
      bytes.push(b);
    }
  }
}
