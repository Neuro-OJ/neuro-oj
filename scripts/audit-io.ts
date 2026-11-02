/** 门禁脚本共用的只读文件访问（测试可替换 root）。 */
export function readTextFileSync(path: string): string {
  return Deno.readTextFileSync(path);
}
