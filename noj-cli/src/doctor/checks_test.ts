import { assertEquals } from "@std/assert";
import type { SystemProbe } from "./probe.ts";
import {
  checkArch,
  checkBaseTools,
  checkDisk,
  checkDockerCli,
  checkDockerCompose,
  checkDockerDaemon,
  checkMemory,
  checkOs,
  checkPort,
} from "./checks.ts";

/** 构造一个可编程的 fake 探针。 */
function fakeProbe(overrides: Partial<SystemProbe> = {}): SystemProbe {
  const ok = (code = 0, stdout = "", stderr = "") => ({ code, stdout, stderr });
  return {
    os: "linux",
    arch: "x86_64",
    run: () => Promise.resolve(ok()),
    memInfo: () =>
      Promise.resolve({
        totalBytes: 8 * 1024 ** 3,
        swapBytes: 2 * 1024 ** 3,
      }),
    diskFree: () => Promise.resolve({ freeBytes: 50 * 1024 ** 3 }),
    portOpen: () => Promise.resolve(false),
    ...overrides,
  };
}

Deno.test("checkOs: linux 通过，非 linux 失败", async () => {
  assertEquals((await checkOs(fakeProbe())).ok, true);
  assertEquals((await checkOs(fakeProbe({ os: "darwin" }))).ok, false);
});

Deno.test("checkArch: x86_64/amd64 通过，其余失败", async () => {
  assertEquals((await checkArch(fakeProbe())).ok, true);
  assertEquals((await checkArch(fakeProbe({ arch: "amd64" }))).ok, true);
  assertEquals((await checkArch(fakeProbe({ arch: "aarch64" }))).ok, false);
});

Deno.test("checkBaseTools: bash/tar/openssl 与 curl 或 wget 齐全时通过", async () => {
  const probe = fakeProbe({
    run: (cmd) => {
      const present = new Set(["bash", "tar", "openssl", "curl"]);
      return Promise.resolve({
        code: present.has(cmd) ? 0 : 1,
        stdout: "",
        stderr: "",
      });
    },
  });
  assertEquals((await checkBaseTools(probe)).ok, true);
});

Deno.test("checkBaseTools: 缺 bash 时失败", async () => {
  const probe = fakeProbe({
    run: (cmd) => {
      const present = new Set(["tar", "openssl", "curl"]);
      return Promise.resolve({
        code: present.has(cmd) ? 0 : 1,
        stdout: "",
        stderr: "",
      });
    },
  });
  const r = await checkBaseTools(probe);
  assertEquals(r.ok, false);
  assertEquals(r.detail.includes("bash"), true);
});

Deno.test("checkDockerCli/Daemon/Compose: 命令可用时通过", async () => {
  const probe = fakeProbe({
    run: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
  });
  assertEquals((await checkDockerCli(probe)).ok, true);
  assertEquals((await checkDockerDaemon(probe)).ok, true);
  assertEquals((await checkDockerCompose(probe)).ok, true);
});

Deno.test("checkDockerDaemon: docker info 失败时失败", async () => {
  const probe = fakeProbe({
    run: (cmd, args) => {
      const isInfo = cmd === "docker" && args[0] === "info";
      return Promise.resolve({
        code: isInfo ? 1 : 0,
        stdout: "",
        stderr: "cannot connect",
      });
    },
  });
  assertEquals((await checkDockerDaemon(probe)).ok, false);
});

Deno.test("checkMemory: 内存不足时失败，无 swap 时告警", async () => {
  const low = await checkMemory(
    fakeProbe({
      memInfo: () =>
        Promise.resolve({ totalBytes: 1 * 1024 ** 3, swapBytes: 0 }),
    }),
  );
  assertEquals(low.ok, false);
  assertEquals(low.severity, "error");

  const noSwap = await checkMemory(
    fakeProbe({
      memInfo: () =>
        Promise.resolve({ totalBytes: 8 * 1024 ** 3, swapBytes: 0 }),
    }),
  );
  assertEquals(noSwap.ok, true);
  assertEquals(noSwap.severity, "warning");
});

Deno.test("checkDisk: 磁盘不足时失败", async () => {
  const r = await checkDisk(
    fakeProbe({
      diskFree: () => Promise.resolve({ freeBytes: 1 * 1024 ** 3 }),
    }),
    "/opt",
  );
  assertEquals(r.ok, false);
});

Deno.test("checkPort: 端口被占用时失败", async () => {
  const r = await checkPort(
    fakeProbe({ portOpen: () => Promise.resolve(true) }),
    8080,
  );
  assertEquals(r.ok, false);
  assertEquals(r.detail.includes("8080"), true);
});
