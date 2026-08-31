import { dirname } from "@std/path";
import { DEPLOY_FILE } from "../config/io.ts";

/** 从 start（缺省当前工作目录）向上查找含 noj-deploy.json 的目录；找到返回绝对路径，否则 null。 */
export function findDeployDir(start?: string): string | null {
  let current = start ?? Deno.cwd();
  current = Deno.realPathSync(current);

  while (true) {
    try {
      Deno.statSync(`${current}/${DEPLOY_FILE}`);
      return current;
    } catch {
      // 无该文件，继续向上。
    }
    const parent = dirname(current);
    if (parent === null || parent === current) return null;
    current = parent;
  }
}
