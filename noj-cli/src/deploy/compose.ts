import type {
  ComponentConfig,
  DeployConfig,
  SecretsConfig,
} from "../config/types.ts";
import { resolveComponentEnv } from "../config/merge.ts";
import { fileExists } from "../util/fs.ts";

/** Compose 文件名（安装目录下）。 */
export const COMPOSE_FILE = "docker-compose.noj.yml";

/** 基础设施组件的命名卷挂载点。 */
const INFRA_VOLUMES: Record<string, string> = {
  postgres: "/var/lib/postgresql/data",
  redis: "/data",
  minio: "/data",
};

/** 将字符串安全地写成双引号 YAML 标量。 */
function yamlStr(v: string): string {
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** 根据组件字段生成 ports 列表。 */
function portsFor(comp: ComponentConfig): string[] {
  const ports: string[] = [];
  if (comp.host_port !== null && comp.host_port !== undefined) {
    const inner = comp.internal_port ?? comp.port;
    if (inner) ports.push(`${comp.host_port}:${inner}`);
  }
  if (
    comp.host_api_port !== null && comp.host_api_port !== undefined &&
    comp.api_port
  ) {
    ports.push(`${comp.host_api_port}:${comp.api_port}`);
  }
  if (
    comp.host_console_port !== null && comp.host_console_port !== undefined &&
    comp.console_port
  ) {
    ports.push(`${comp.host_console_port}:${comp.console_port}`);
  }
  return ports;
}

/** 渲染 docker-compose.noj.yml 文本：只含 enabled 且 method=docker 的组件。 */
export function renderCompose(
  config: DeployConfig,
  secrets: SecretsConfig,
): string {
  const dockerComponents = Object.entries(config.components).filter(
    ([, c]) => c.enabled && c.method === "docker",
  );
  const lines: string[] = ["services:"];
  const usedVolumes = new Set<string>();

  for (const [name, comp] of dockerComponents) {
    lines.push(`  ${name}:`);
    lines.push(`    container_name: noj-${name}`);
    if (comp.image) lines.push(`    image: ${yamlStr(comp.image)}`);

    const env = resolveComponentEnv(config, secrets, name);
    if (Object.keys(env).length > 0) {
      lines.push("    environment:");
      for (const [k, v] of Object.entries(env)) {
        lines.push(`      ${k}: ${yamlStr(v)}`);
      }
    }

    const ports = portsFor(comp);
    if (ports.length > 0) {
      lines.push("    ports:");
      for (const p of ports) lines.push(`      - ${yamlStr(p)}`);
    }

    const mount = INFRA_VOLUMES[name];
    if (mount) {
      usedVolumes.add(`${name}-data`);
      lines.push("    volumes:");
      lines.push(`      - ${name}-data:${mount}`);
    }
  }

  if (usedVolumes.size > 0) {
    lines.push("volumes:");
    for (const v of usedVolumes) lines.push(`  ${v}:`);
  }

  return lines.join("\n") + "\n";
}

/**
 * 确保安装目录下存在最新 compose 文件。
 * 文件不存在或内容不同则重写；内容相同则复用现文件。
 * 返回 compose 文件绝对路径。
 */
export async function ensureComposeFile(
  dir: string,
  config: DeployConfig,
  secrets: SecretsConfig,
): Promise<string> {
  const path = `${dir}/${COMPOSE_FILE}`;
  const rendered = renderCompose(config, secrets);
  const exists = await fileExists(path);
  if (exists) {
    const current = await Deno.readTextFile(path);
    if (current === rendered) return path;
  }
  await Deno.writeTextFile(path, rendered);
  return path;
}
