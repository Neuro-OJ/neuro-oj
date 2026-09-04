/** 进程 PID 文件路径：${runDir}/${component}.pid。 */
export function pidPath(runDir: string, component: string): string {
  return `${runDir}/${component}.pid`;
}

/** 写 PID 文件（自动创建 run 目录）。 */
export async function writePid(
  runDir: string,
  component: string,
  pid: number,
): Promise<void> {
  await Deno.mkdir(runDir, { recursive: true });
  await Deno.writeTextFile(pidPath(runDir, component), String(pid));
}

/** 读 PID；缺失或非正整数返回 null。 */
export async function readPid(
  runDir: string,
  component: string,
): Promise<number | null> {
  try {
    const text = (await Deno.readTextFile(pidPath(runDir, component))).trim();
    const n = Number(text);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** 删除 PID 文件（不存在则静默）。 */
export async function removePid(
  runDir: string,
  component: string,
): Promise<void> {
  try {
    await Deno.remove(pidPath(runDir, component));
  } catch {
    // 已不存在则忽略
  }
}
