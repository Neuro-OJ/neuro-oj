// 从统一工程元数据选择现有 Core 域任务；新模块同时由完整分片任务覆盖。

/** 选择器读取的元数据子集（`dev-docs/engineering/module-boundaries.json`）。 */
export interface CoreCiMetadata {
  legacyDomainToModule: Record<string, string>;
}

/** 按 `CORE_<DOMAIN>=true` 变更标志选出受影响的域；共享改动覆盖全部域。 */
export function selectDomains(
  metadata: CoreCiMetadata,
  env: Record<string, string | undefined>,
): string[] {
  const domains = Object.keys(metadata.legacyDomainToModule).sort();
  if (domains.length === 0) {
    throw new Error("Core CI 元数据没有域别名，拒绝零测试选择");
  }
  if (env.CORE_SHARED === "true") return [...domains, "shared"];
  return domains.filter((name) =>
    env[`CORE_${name.toUpperCase().replaceAll("-", "_")}`] === "true"
  );
}

if (import.meta.main) {
  const metadata = JSON.parse(
    await Deno.readTextFile(
      new URL(
        "../dev-docs/engineering/module-boundaries.json",
        import.meta.url,
      ),
    ),
  ) as CoreCiMetadata;
  const domains = selectDomains(metadata, Deno.env.toObject());
  const output = Deno.env.get("GITHUB_OUTPUT");
  if (!output) throw new Error("缺少 GITHUB_OUTPUT");
  await Deno.writeTextFile(
    output,
    `core-domains=${JSON.stringify(domains)}\n`,
    { append: true },
  );
}
