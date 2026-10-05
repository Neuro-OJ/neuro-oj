/** 检查统一清单、构建副本和已发布 v1 摘要，禁止静默修改计量规则。 */
const files = [
  "fixtures/noj-wasm-v1.json",
  "noj-core/src/domains/catalog/types/noj-wasm-v1.json",
  "noj-judge/src/oi/noj-wasm-v1.json",
];
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
const standard = JSON.parse(await Deno.readTextFile(files[0]));
for (const file of files.slice(1)) {
  if (
    canonical(JSON.parse(await Deno.readTextFile(file))) !== canonical(standard)
  ) throw new Error(`标准副本不一致：${file}`);
}
const { hash, ...payload } = standard;
const digest = await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(canonical(payload)),
);
const expected = [...new Uint8Array(digest)].map((b) =>
  b.toString(16).padStart(2, "0")
).join("");
if (
  hash !== "dd45773b77ab74fa69e15427760a86dc8defcac79d2dfb61ec91c18eba08a906"
) throw new Error("已发布 v1 不允许原地修改，请发布新标准版本");
if (hash !== expected) throw new Error("统一标准摘要不匹配");
if (standard.id !== "noj-wasm-v1" || standard.fuel_per_ms !== 1_000_000) {
  throw new Error("统一计量规则发生未版本化的变更");
}
console.log(`WASM 统一标准副本与摘要一致：${standard.id} ${hash}`);
