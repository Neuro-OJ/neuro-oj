import type { SystemProbe } from "./probe.ts";
import type { CheckResult } from "./checks.ts";
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

/** doctor 运行选项。 */
export interface DoctorOptions {
  port: number;
  installDir: string;
}

/** doctor 检测报告。 */
export interface DoctorReport {
  checks: CheckResult[];
  /** 任一 error 级检测失败即为 true。 */
  failed: boolean;
}

/** 依次执行全部只读检测，返回报告。 */
export async function runDoctor(
  probe: SystemProbe,
  opts: DoctorOptions,
): Promise<DoctorReport> {
  const checks: CheckResult[] = [
    await checkOs(probe),
    await checkArch(probe),
    await checkBaseTools(probe),
    await checkDockerCli(probe),
    await checkDockerDaemon(probe),
    await checkDockerCompose(probe),
    await checkMemory(probe),
    await checkDisk(probe, opts.installDir),
    await checkPort(probe, opts.port),
  ];
  const failed = checks.some((c) => c.severity === "error" && !c.ok);
  return { checks, failed };
}
