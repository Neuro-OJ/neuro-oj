import type { DeployConfig, SecretsConfig } from "./types.ts";
import { DEPLOY_FILE, SECRETS_FILE } from "./io.ts";

/**
 * 只读取部署配置（**不读密钥**）。
 *
 * 供 `backup list` / `backup prune` 这类**只做文件系统操作**的命令使用
 * （#515 P6）。列举/清理备份只需要安装目录，若也强制要求密钥文件存在，
 * 用户会在密钥丢失或尚未生成时**连"有哪些备份"都看不到**——
 * 而那恰恰是最需要列备份的场景。
 */
export async function loadDeployConfig(dir: string): Promise<DeployConfig> {
  const deployPath = `${dir}/${DEPLOY_FILE}`;
  const raw = await Deno.readTextFile(deployPath).catch((e) => {
    throw new Error(`无法读取部署配置 ${deployPath}: ${e.message}`);
  });
  return JSON.parse(raw) as DeployConfig;
}

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
