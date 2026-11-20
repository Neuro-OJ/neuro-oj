import denoJson from "../deno.json" with { type: "json" };

/** noj-cli 版本号，唯一事实源为 `deno.json` 的 `version`（发布时由版本一致性门禁校验）。 */
export const VERSION: string = denoJson.version;
