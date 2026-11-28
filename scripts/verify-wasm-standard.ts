/** 检查统一清单、构建副本和已发布标准摘要，禁止静默修改计量规则。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const v = value as Record<string, unknown>;
    return `{${
      Object.keys(v).sort().map((k) =>
        `${JSON.stringify(k)}:${canonical(v[k])}`
      ).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
function hashValue(value: unknown): Promise<string> {
  return hashBytes(new TextEncoder().encode(canonical(value)));
}
async function hashBytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
const published = {
  "noj-wasm-v3":
    "cad6c597aae5d43af93544bbba899656a86a2453bd79dbe90508565800e6c9c7",
};
const standards = [];
for (const [id, frozenHash] of Object.entries(published)) {
  const standard = JSON.parse(await Deno.readTextFile(`fixtures/${id}.json`));
  for (
    const file of [
      `noj-core/src/modules/problems/types/${id}.json`,
      `noj-judge/src/oi/${id}.json`,
    ]
  ) {
    if (
      canonical(JSON.parse(await Deno.readTextFile(file))) !==
        canonical(standard)
    ) {
      throw new Error(`标准副本不一致：${file}`);
    }
  }
  const { hash, ...payload } = standard;
  if (hash !== frozenHash || hash !== await hashValue(payload)) {
    throw new Error(`已发布 ${id} 摘要不匹配，禁止原地修改`);
  }
  if (standard.id !== id || standard.fuel_per_ms !== 20_000_000) {
    throw new Error("统一计量规则发生未版本化的变更");
  }
  standards.push(standard);
  console.log(`WASM 统一标准副本与摘要一致：${id} ${hash}`);
}
const [v3] = standards;
const recipe = JSON.parse(
  await Deno.readTextFile("noj-judge/toolchain/recipe.json"),
);
const components = JSON.parse(
  await Deno.readTextFile("noj-judge/toolchain/components.json"),
);
if (
  await hashValue(recipe) !== v3.toolchain_recipe_sha256 ||
  await hashValue(components) !== v3.toolchain_components_sha256
) {
  throw new Error("工具链构建配置或产物清单与标准不一致");
}
for (const patch of recipe.patches) {
  if (
    await hashBytes(
      await Deno.readFile(`noj-judge/toolchain/patches/${patch.path}`),
    ) !== patch.sha256
  ) {
    throw new Error(`工具链补丁摘要不匹配：${patch.path}`);
  }
}
if (v3.time_unit.id !== "reference-millisecond") {
  throw new Error("v3 必须声明参考毫秒单位");
}
