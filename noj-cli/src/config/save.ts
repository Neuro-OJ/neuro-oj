import type { DeployConfig, SecretsConfig } from "./types.ts";
import {
  DEPLOY_FILE,
  DEPLOY_FILE_MODE,
  SECRETS_FILE,
  SECRETS_FILE_MODE,
} from "./io.ts";

async function atomicWrite(
  path: string,
  data: string,
  mode: number,
): Promise<void> {
  const tmp = `${path}.tmp-${Deno.pid}-${crypto.randomUUID()}`;
  await Deno.writeTextFile(tmp, data);
  await Deno.chmod(tmp, mode);
  await Deno.rename(tmp, path);
}

function utcNow(): string {
  return new Date().toISOString();
}

/** 将部署配置与密钥原子写入目录，并设置权限（deploy 644 / secrets 600）。 */
export async function saveDeployment(
  dir: string,
  config: DeployConfig,
  secrets: SecretsConfig,
): Promise<void> {
  const cfg = structuredClone(config);
  cfg.updated_at = utcNow();
  const sec = structuredClone(secrets);
  sec.updated_at = utcNow();

  await atomicWrite(
    `${dir}/${DEPLOY_FILE}`,
    JSON.stringify(cfg, null, 2) + "\n",
    DEPLOY_FILE_MODE,
  );
  await atomicWrite(
    `${dir}/${SECRETS_FILE}`,
    JSON.stringify(sec, null, 2) + "\n",
    SECRETS_FILE_MODE,
  );
}
