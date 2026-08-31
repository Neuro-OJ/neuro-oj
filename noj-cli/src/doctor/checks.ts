import type { SystemProbe } from "./probe.ts";

/** 单项检测结果。 */
export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** error 级失败导致 doctor 退出码非零；warning 仅提示。 */
  severity: "error" | "warning";
}

/** 最低内存：2 GiB。 */
export const MIN_MEM_BYTES = 2 * 1024 ** 3;
/** 最低可用磁盘：10 GiB。 */
export const MIN_DISK_BYTES = 10 * 1024 ** 3;

function result(
  name: string,
  ok: boolean,
  detail: string,
  severity: "error" | "warning" = "error",
): CheckResult {
  return { name, ok, detail, severity };
}

/** 检测操作系统是否为 linux。 */
export function checkOs(probe: SystemProbe): CheckResult {
  const ok = probe.os === "linux";
  return result(
    "操作系统",
    ok,
    ok ? `linux (${probe.os})` : `仅支持 linux，当前 ${probe.os}`,
  );
}

/** 检测 CPU 架构是否为 x86_64 / amd64。 */
export function checkArch(probe: SystemProbe): CheckResult {
  const ok = probe.arch === "x86_64" || probe.arch === "amd64";
  return result(
    "CPU 架构",
    ok,
    ok ? `${probe.arch}` : `仅支持 x86_64/amd64，当前 ${probe.arch}`,
  );
}

/** 检测基础工具：bash、tar、openssl，以及 curl 或 wget 至少其一。 */
export async function checkBaseTools(probe: SystemProbe): Promise<CheckResult> {
  const required = ["bash", "tar", "openssl"];
  const either = ["curl", "wget"];
  const missing: string[] = [];
  for (const tool of required) {
    const r = await probe.run(tool, ["--version"]);
    if (r.code !== 0) missing.push(tool);
  }
  let eitherOk = false;
  for (const tool of either) {
    const r = await probe.run(tool, ["--version"]);
    if (r.code === 0) eitherOk = true;
  }
  if (!eitherOk) missing.push("curl 或 wget");
  const ok = missing.length === 0;
  return result(
    "基础工具",
    ok,
    ok ? "bash/tar/openssl/curl 或 wget 齐全" : `缺失: ${missing.join(", ")}`,
  );
}

/** 检测 Docker CLI 是否可用。 */
export async function checkDockerCli(probe: SystemProbe): Promise<CheckResult> {
  const r = await probe.run("docker", ["--version"]);
  const ok = r.code === 0;
  return result("Docker CLI", ok, ok ? r.stdout.trim() : "docker 命令不可用");
}

/** 检测 Docker daemon 是否运行（docker info 成功）。 */
export async function checkDockerDaemon(
  probe: SystemProbe,
): Promise<CheckResult> {
  const r = await probe.run("docker", ["info"]);
  const ok = r.code === 0;
  return result(
    "Docker daemon",
    ok,
    ok ? "daemon 运行中" : r.stderr.trim() || "daemon 未运行",
  );
}

/** 检测 Docker Compose v2 是否可用。 */
export async function checkDockerCompose(
  probe: SystemProbe,
): Promise<CheckResult> {
  const r = await probe.run("docker", ["compose", "version"]);
  const ok = r.code === 0;
  return result(
    "Docker Compose v2",
    ok,
    ok ? r.stdout.trim() : "docker compose v2 不可用",
  );
}

/** 检测内存与 swap：内存不足为 error，无 swap 为 warning。 */
export async function checkMemory(probe: SystemProbe): Promise<CheckResult> {
  const mem = await probe.memInfo();
  if (mem.totalBytes < MIN_MEM_BYTES) {
    return result(
      "内存",
      false,
      `可用内存 ${(mem.totalBytes / 1024 ** 3).toFixed(1)} GiB，低于 ${
        MIN_MEM_BYTES / 1024 ** 3
      } GiB`,
    );
  }
  if (mem.swapBytes === 0) {
    return result(
      "内存",
      true,
      `内存 ${(mem.totalBytes / 1024 ** 3).toFixed(1)} GiB，无 swap`,
      "warning",
    );
  }
  return result(
    "内存",
    true,
    `内存 ${(mem.totalBytes / 1024 ** 3).toFixed(1)} GiB，swap ${
      (mem.swapBytes / 1024 ** 3).toFixed(1)
    } GiB`,
  );
}

/** 检测目标目录可用磁盘。 */
export async function checkDisk(
  probe: SystemProbe,
  path: string,
): Promise<CheckResult> {
  const disk = await probe.diskFree(path);
  const ok = disk.freeBytes >= MIN_DISK_BYTES;
  return result(
    "磁盘空间",
    ok,
    ok
      ? `${path} 可用 ${(disk.freeBytes / 1024 ** 3).toFixed(1)} GiB`
      : `${path} 可用 ${(disk.freeBytes / 1024 ** 3).toFixed(1)} GiB，低于 ${
        MIN_DISK_BYTES / 1024 ** 3
      } GiB`,
  );
}

/** 检测端口是否被占用。 */
export async function checkPort(
  probe: SystemProbe,
  port: number,
): Promise<CheckResult> {
  const occupied = await probe.portOpen(port);
  return result(
    "端口占用",
    !occupied,
    occupied ? `端口 ${port} 已被占用` : `端口 ${port} 空闲`,
  );
}
