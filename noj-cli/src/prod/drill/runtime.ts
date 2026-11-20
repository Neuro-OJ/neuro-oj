import type { CommandRunner } from "../../runtime/command.ts";

/** 将一次演练的全部命令绑定到同一个专用 Docker socket。 */
export function withDockerHost(
  base: CommandRunner,
  dockerHost: string,
): CommandRunner {
  const envOf = (env?: Record<string, string>): Record<string, string> => ({
    ...Deno.env.toObject(),
    ...env,
    DOCKER_HOST: dockerHost,
  });
  return {
    run(cmd, args, options) {
      return base.run(cmd, args, {
        ...options,
        env: envOf(options?.env),
      });
    },
    spawn(options) {
      return base.spawn({ ...options, env: envOf(options.env) });
    },
    stream: base.stream === undefined
      ? undefined
      : (cmd, args, onLine, options) =>
        base.stream!(cmd, args, onLine, {
          ...options,
          env: envOf(options?.env),
        }),
  };
}

/** 各隔离服务失败时保留具体阶段。 */
export const START_SERVICE_ERRORS = {
  migrate: "数据库迁移失败（migrate）",
  "gateway-migrate":
    "Gateway 数据库迁移与默认配额初始化失败（gateway-migrate）",
  core: "隔离 core 启动失败",
} as const;
