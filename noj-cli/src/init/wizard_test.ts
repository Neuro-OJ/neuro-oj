import { assertEquals } from "@std/assert";
import type { PromptIO } from "../tui/io.ts";
import type { SystemProbe } from "../doctor/probe.ts";
import { runInitWizard } from "./wizard.ts";

class FakeIO implements PromptIO {
  writes: string[] = [];
  answers: string[];
  constructor(answers: string[]) {
    this.answers = answers;
  }
  write(text: string): void {
    this.writes.push(text);
  }
  readLine(_p: string): Promise<string> {
    return Promise.resolve(this.answers.shift() ?? "");
  }
  readSecret(_p: string): Promise<string> {
    return Promise.resolve(this.answers.shift() ?? "");
  }
}

function okProbe(): SystemProbe {
  return {
    os: "linux",
    arch: "x86_64",
    run: () => Promise.resolve({ code: 0, stdout: "ok", stderr: "" }),
    memInfo: () =>
      Promise.resolve({ totalBytes: 8 * 1024 ** 3, swapBytes: 2 * 1024 ** 3 }),
    diskFree: () => Promise.resolve({ freeBytes: 50 * 1024 ** 3 }),
    portOpen: () => Promise.resolve(false),
  };
}

Deno.test("runInitWizard: dev 模式（显式 mode）生成 dev 配置", async () => {
  // 流程：端口输入 8080 → 数据目录输入 /opt/data → 摘要确认 y
  const io = new FakeIO(["8080", "/opt/data", "y"]);
  const { config, secrets } = await runInitWizard(io, okProbe(), {
    mode: "dev",
    installDir: "/opt/neuro-oj",
    version: "0.1.0",
  });
  assertEquals(config.type, "dev");
  assertEquals(config.state, "stopped");
  assertEquals(secrets.secrets["JWT_SECRET"]!.length >= 32, true);
});

Deno.test("runInitWizard: 未指定 mode 时先选择模式（选 prod）", async () => {
  // 选择 prod(2) → 域名 → https y → 端口 8080 → judge n → email disabled(1) → 确认 y
  const io = new FakeIO(["2", "oj.example.com", "y", "8080", "n", "1", "y"]);
  const { config } = await runInitWizard(io, okProbe(), {
    installDir: "/opt/neuro-oj",
    version: "0.1.0",
  });
  assertEquals(config.type, "prod");
  assertEquals(config.env["DOMAIN"], "oj.example.com");
});

Deno.test("runInitWizard: 摘要确认 n 时抛错", async () => {
  const io = new FakeIO(["8080", "/opt/data", "n"]);
  let threw = false;
  try {
    await runInitWizard(io, okProbe(), {
      mode: "dev",
      installDir: "/opt/neuro-oj",
      version: "0.1.0",
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
