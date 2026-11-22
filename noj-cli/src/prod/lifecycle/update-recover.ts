import { digestCandidateFiles } from "./upgrade.ts";
import type { UpgradeState } from "../upgrade-state.ts";

/**
 * 未完成升级的暂存目录能否原样复用。
 *
 * 只有目录仍在、且当前文件摘要与 checkpoint 记录逐项一致才复用；否则返回
 * `null`，由调用方重新下载候选发布文件。
 */
export async function reusableCandidateDir(
  state: UpgradeState | null,
): Promise<string | null> {
  if (state === null || state.files_staged_dir === null) return null;
  const dir = state.files_staged_dir;
  try {
    const info = await Deno.stat(dir);
    if (!info.isDirectory) return null;
    const actual = await digestCandidateFiles(dir);
    const expected = state.files;
    if (actual.length !== expected.length) return null;
    const intact = actual.every((file, index) => {
      const reference = expected[index];
      return reference !== undefined && file.name === reference.name &&
        file.sha256 === reference.sha256;
    });
    return intact ? dir : null;
  } catch {
    return null;
  }
}
