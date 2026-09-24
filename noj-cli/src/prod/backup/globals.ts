/**
 * 把 `pg_dumpall --globals-only` 的 `CREATE ROLE` 改为幂等形式。
 *
 * 迁移 bash `prepare_idempotent_globals`（backup.sh:150-170）。
 *
 * ## 为什么需要
 *
 * 目标 PostgreSQL 已由 `POSTGRES_USER` 创建了默认角色，直接重放
 * `CREATE ROLE` 会以 "role already exists" 失败。改写为
 * `DO $role$ BEGIN IF NOT EXISTS (...) THEN CREATE ROLE …; END IF; END $role$;`
 * 后即可重复执行。
 *
 * ## 为什么单独一个模块
 *
 * 生产 `backup restore --confirm` 与隔离 `drill` **都要**在恢复 PostgreSQL 前
 * 做这一步；原先它住在 `drill/drill.ts` 里，于是生产路径要么反向依赖 drill、
 * 要么抄一份。抄一份的后果是两者在转义/幂等语义上漂移——而这一步出错会直接
 * 导致恢复失败或角色缺失。
 *
 * 本模块是纯函数（只读写文件、无 compose/docker 依赖），因此可以放在
 * 两条路径的共同下层。
 */

/**
 * 把 `source` 改写成幂等版本写入 `target`。
 *
 * @returns `0` 成功；`1` 源文件不可读（已写出空 `target`，调用方据此报错）。
 */
export async function makeIdempotentGlobals(
  source: string,
  target: string,
): Promise<number> {
  let text: string;
  try {
    text = await Deno.readTextFile(source);
  } catch {
    await Deno.writeTextFile(target, "");
    return 1;
  }
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("CREATE ROLE ")) {
      const identifier = line.slice("CREATE ROLE ".length).replace(/;\s*$/, "");
      let name = identifier;
      if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
        name = name.slice(1, -1).replace(/""/g, '"');
      }
      const escaped = name.replace(/'/g, "''");
      out.push(
        `DO $role$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${escaped}') THEN CREATE ROLE ${identifier}; END IF; END $role$;`,
      );
      continue;
    }
    out.push(line);
  }
  await Deno.writeTextFile(target, out.join("\n"));
  return 0;
}
