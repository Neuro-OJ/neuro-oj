// Gate runner 公共函数：执行子进程并继承输出，失败时退出非零。
export async function run(
  args: string[],
  cwd?: string,
): Promise<void> {
  const [cmd, ...rest] = args;
  const command = new Deno.Command(cmd, {
    args: rest,
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const result = await command.output();
  if (!result.success) {
    Deno.exit(result.code);
  }
}
