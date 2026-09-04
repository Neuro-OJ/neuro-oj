import type { DeployConfig, SecretsConfig } from "./types.ts";
import { DEPLOY_FILE, SECRETS_FILE } from "./io.ts";

/** 从目录读取部署配置与密钥；任一文件缺失/损坏即抛错。 */
export async function loadDeployment(
  dir: string,
): Promise<{ config: DeployConfig; secrets: SecretsConfig }> {
  const deployPath = `${dir}/${DEPLOY_FILE}`;
  const secretsPath = `${dir}/${SECRETS_FILE}`;

  const rawDeploy = await Deno.readTextFile(deployPath).catch((e) => {
    throw new Error(`无法读取部署配置 ${deployPath}: ${e.message}`);
  });
  const rawSecrets = await Deno.readTextFile(secretsPath).catch((e) => {
    throw new Error(`无法读取密钥配置 ${secretsPath}: ${e.message}`);
  });

  const config = JSON.parse(rawDeploy) as DeployConfig;
  const secrets = JSON.parse(rawSecrets) as SecretsConfig;
  return { config, secrets };
}
