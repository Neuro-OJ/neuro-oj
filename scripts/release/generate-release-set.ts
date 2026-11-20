/**
 * 从构建验证产物生成不可变生产发布集。
 *
 * 发布集只接受 verify-release 产出的镜像路径、版本和 digest；不允许在这里
 * 重新推导或替换 digest。迁移级别同时记录 Core 与 Gateway 的最新迁移编号，
 * 让升级器可以在迁移前把目标发布集写入 checkpoint。
 */

import { join } from "@std/path";
import {
  RELEASE_SET_COMPONENT_IMAGES,
  RELEASE_SET_COMPONENTS,
  type ReleaseSet,
  SDK_STANDARD,
  validateReleaseSet,
} from "../../noj-cli/src/prod/release-set.ts";

const encoder = new TextEncoder();

function fail(message: string): never {
  throw new Error(`生成发布集失败：${message}`);
}

async function latestMigrationPrefix(
  dir: string,
  label: string,
): Promise<string> {
  const prefixes: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const match = /^(\d+)_.*\.sql$/.exec(entry.name);
    if (match !== null) prefixes.push(match[1]!);
  }
  if (prefixes.length === 0) fail(`${label} 目录没有 SQL 迁移：${dir}`);
  prefixes.sort((left, right) =>
    left.length === right.length
      ? left.localeCompare(right)
      : left.length - right.length
  );
  return prefixes.at(-1)!;
}

async function readDigestMetadata(
  metadataDir: string,
  component: (typeof RELEASE_SET_COMPONENTS)[number],
  image: string,
  release: string,
): Promise<{ image: string; digest: string }> {
  const shortName = image.slice(image.lastIndexOf("/") + 1);
  const path = join(metadataDir, `release-${shortName}.txt`);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    fail(`缺少 ${component} 发布元数据 ${path}：${(error as Error).message}`);
  }
  const fields = text.trim().split(/\s+/);
  if (fields.length !== 3) {
    fail(`${path} 必须包含 image、version、digest 三列`);
  }
  if (fields[0] !== image) {
    fail(`${path} 的镜像路径 ${fields[0]} 与发布集 ${image} 不一致`);
  }
  if (fields[1] !== release) {
    fail(`${path} 的版本 ${fields[1]} 与 Release ${release} 不一致`);
  }
  return { image: fields[0]!, digest: fields[2]! };
}

export async function generateReleaseSet(options: {
  metadataDir: string;
  release: string;
  coreMigrationsDir: string;
  gatewayMigrationsDir: string;
}): Promise<ReleaseSet> {
  const components = {} as ReleaseSet["components"];
  for (const component of RELEASE_SET_COMPONENTS) {
    const image = RELEASE_SET_COMPONENT_IMAGES[component];
    components[component] = await readDigestMetadata(
      options.metadataDir,
      component,
      image,
      options.release,
    );
  }
  const migrationLevel = `core:${await latestMigrationPrefix(
    options.coreMigrationsDir,
    "Core",
  )},gateway:${await latestMigrationPrefix(
    options.gatewayMigrationsDir,
    "Gateway",
  )}`;
  return validateReleaseSet({
    schema_version: 1,
    release: options.release,
    migration_level: migrationLevel,
    protocol_versions: { evaluation: 3, gateway: 3 },
    components,
    cli_version: options.release,
    ide_version: options.release,
    sdk_standard: SDK_STANDARD,
  }, options.release);
}

if (import.meta.main) {
  const [
    metadataDir,
    release,
    coreMigrationsDir,
    gatewayMigrationsDir,
    output,
  ] = Deno.args;
  if (!metadataDir || !release || !coreMigrationsDir || !gatewayMigrationsDir) {
    console.error(
      "用法：deno run -A scripts/release/generate-release-set.ts <metadata-dir> <release> <core-drizzle> <gateway-drizzle> [output]",
    );
    Deno.exit(2);
  }
  const releaseSet = await generateReleaseSet({
    metadataDir,
    release,
    coreMigrationsDir,
    gatewayMigrationsDir,
  });
  const target = output ?? "release-set.json";
  await Deno.writeFile(
    target,
    encoder.encode(JSON.stringify(releaseSet, null, 2) + "\n"),
  );
  console.log(
    `已生成 ${target}（${releaseSet.release}，${releaseSet.migration_level}）`,
  );
}
