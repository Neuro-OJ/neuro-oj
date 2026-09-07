import { dirname, resolve } from "@std/path";

export type ContextKind = "production" | "json" | "judge" | "none";

export interface CliContext {
  cwd: string;
  kind: ContextKind;
  dir: string | null;
}

function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

export function detectKind(dir: string): ContextKind | null {
  const prod = isFile(`${dir}/.env.prod`) &&
    isFile(`${dir}/docker-compose.prod.yml`);
  if (prod) return "production";
  const json = isFile(`${dir}/noj-deploy.json`) &&
    isFile(`${dir}/noj-secrets.json`);
  if (json) return "json";
  const judge = isFile(`${dir}/.env.judge`) &&
    isFile(`${dir}/docker-compose.judge.yml`);
  if (judge) return "judge";
  return null;
}

export function findContextDir(
  start?: string,
  kind?: ContextKind,
): string | null {
  let current = start ?? Deno.cwd();
  try {
    current = Deno.realPathSync(current);
  } catch {
    return null;
  }
  while (true) {
    const detected = detectKind(current);
    if (detected !== null && (kind === undefined || detected === kind)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === null || parent === current) return null;
    current = parent;
  }
}

export function resolveContext(opts: {
  cwd?: string;
  dir?: string;
  mode?: ContextKind;
}): CliContext {
  const cwd = opts.cwd ?? Deno.cwd();
  if (opts.dir !== undefined) {
    const abs = resolve(cwd, opts.dir);
    const kind = detectKind(abs);
    if (kind === null) return { cwd, kind: "none", dir: abs };
    if (opts.mode !== undefined && kind !== opts.mode) {
      throw new Error(`目录 ${abs} 不是 ${opts.mode} 上下文`);
    }
    return { cwd, kind, dir: abs };
  }
  if (opts.mode !== undefined) {
    const dir = findContextDir(cwd, opts.mode);
    return { cwd, kind: dir ? opts.mode : "none", dir };
  }
  const dir = findContextDir(cwd);
  const kind = dir ? detectKind(dir) ?? "none" : "none";
  return { cwd, kind, dir };
}
