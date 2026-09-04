import { assertEquals } from "@std/assert";
import type { SystemProbe } from "./probe.ts";
import { runDoctor } from "./doctor.ts";
import { formatReport } from "./report.ts";

function allOkProbe(): SystemProbe {
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

Deno.test("runDoctor: 全部通过时 failed 为 false", async () => {
  const report = await runDoctor(allOkProbe(), {
    port: 8080,
    installDir: "/opt",
  });
  assertEquals(report.failed, false);
  assertEquals(report.checks.length >= 9, true);
});

Deno.test("runDoctor: 任一 error 级失败时 failed 为 true", async () => {
  const probe = allOkProbe();
  probe.os = "darwin";
  const report = await runDoctor(probe, { port: 8080, installDir: "/opt" });
  assertEquals(report.failed, true);
});

Deno.test("runDoctor: 仅 warning 不导致 failed", async () => {
  const probe = allOkProbe();
  probe.memInfo = () =>
    Promise.resolve({ totalBytes: 8 * 1024 ** 3, swapBytes: 0 });
  const report = await runDoctor(probe, { port: 8080, installDir: "/opt" });
  assertEquals(report.failed, false);
});

Deno.test("formatReport: 包含通过/失败/告警标记与检测名", () => {
  const report = {
    failed: true,
    checks: [
      {
        name: "操作系统",
        ok: true,
        detail: "linux",
        severity: "error" as const,
      },
      {
        name: "端口占用",
        ok: false,
        detail: "端口 8080 已被占用",
        severity: "error" as const,
      },
      {
        name: "内存",
        ok: true,
        detail: "无 swap",
        severity: "warning" as const,
      },
    ],
  };
  const text = formatReport(report);
  assertEquals(text.includes("操作系统"), true);
  assertEquals(text.includes("\x1b[32m[通过]\x1b[0m"), true);
  assertEquals(text.includes("\x1b[31m[失败]\x1b[0m"), true);
  assertEquals(text.includes("\x1b[33m[告警]\x1b[0m"), true);
});
