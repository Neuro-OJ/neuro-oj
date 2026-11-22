/**
 * `noj-cli problem migrate`：把旧格式 problem.json 改写为当前格式。
 *
 * 与服务端导入期转换共用 noj-core 的 `upgradeBundleManifest`，保证离线迁移
 * 结果与导入时的自动转换一致；不写入任何平台缺省值。
 */
import { upgradeBundleManifest } from "../../../noj-core/src/modules/problems/types/problem-bundle.ts";

/** 迁移结果。 */
export interface MigrateResult {
  /** 是否发生改写（已是当前格式时为 false）。 */
  changed: boolean;
  /** 改写后的 problem.json 文本（含结尾换行）。 */
  text: string;
  /** 转换过程中的告警（字段移除等）。 */
  warnings: string[];
}

/** 迁移 problem.json 文本；非法 JSON 或不支持的格式抛错。 */
export function migrateManifest(source: string): MigrateResult {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (err) {
    throw new Error(`problem.json 不是合法 JSON：${(err as Error).message}`);
  }
  const { manifest, warnings } = upgradeBundleManifest(raw);
  if (warnings.length === 0) {
    return { changed: false, text: source, warnings };
  }
  return {
    changed: true,
    text: JSON.stringify(manifest, null, 2) + "\n",
    // 迁移本身就是「更新源 problem.json」，去掉提示运行本命令的那条告警。
    warnings: warnings.filter((w) => !w.includes("noj problem migrate")),
  };
}
