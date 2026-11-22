/**
 * 演练网络内的业务服务发现。
 *
 * 隔离演练不映射宿主机端口，业务验收必须使用 Core 容器在演练网络中的
 * 地址，避免误连生产或开发服务。
 */
import type { CommandRunner } from "../../runtime/command.ts";
import { drillComposeArgs } from "./plan.ts";

export interface DrillNetworkContext {
  projectName: string;
  composeEnvFile: string;
  composeFile: string;
  overrideFile: string;
  judge: boolean;
}

/** 解析 Core 的 API 基址（经容器 IP，不依赖宿主机端口映射）。 */
export async function resolveCoreBaseUrl(
  ctx: DrillNetworkContext,
  runner: CommandRunner,
  dockerBin: string,
): Promise<string> {
  const idRes = await runner.run(
    dockerBin,
    drillComposeArgs({
      projectName: ctx.projectName,
      composeEnvFile: ctx.composeEnvFile,
      composeFile: ctx.composeFile,
      overrideFile: ctx.overrideFile,
      judge: ctx.judge,
      command: ["ps", "-q", "core"],
    }),
  );
  const containerId = idRes.stdout.trim().split("\n")[0]?.trim() ?? "";
  if (containerId === "") throw new Error("无法定位隔离 core 容器");

  const inspect = await runner.run(dockerBin, [
    "inspect",
    "--format",
    "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
    containerId,
  ]);
  const ip = inspect.stdout.trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    throw new Error(`无法解析隔离 core 的容器 IP：${JSON.stringify(ip)}`);
  }
  return `http://${ip}:8000/api/v1`;
}
