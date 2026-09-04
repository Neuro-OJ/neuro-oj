/** 判断 path 是否为存在的文件（目录/缺失/异常均返回 false）。 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    const st = await Deno.stat(path);
    return st.isFile;
  } catch {
    return false;
  }
}
