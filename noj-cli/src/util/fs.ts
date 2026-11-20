/** 普通文件判定（同 shell `-f`）：目录、缺失或任何异常均返回 false。 */
export async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/** 存在性判定（同 shell `-e`，但悬空软链也算存在）。 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}
