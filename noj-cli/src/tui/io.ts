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
      const wasRaw = Deno.stdin.isTerminal();
      if (wasRaw) Deno.stdin.setRaw(true);
      try {
        const buf = new Uint8Array(1024);
        const n = await Deno.stdin.read(buf);
        if (n === null) return "";
        return decoder.decode(buf.subarray(0, n)).replace(/\r?\n$/, "");
      } finally {
        if (wasRaw) Deno.stdin.setRaw(false);
        this.write("\n");
      }
    },
  };
}
