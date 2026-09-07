export interface JudgeEnv {
  values: Record<string, string>;
}

export function envValue(env: JudgeEnv, key: string): string | undefined {
  return env.values[key];
}

export function loadJudgeEnv(file: string): JudgeEnv {
  const values: Record<string, string> = {};
  try {
    const text = Deno.readTextFileSync(file);
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes("=")) continue;
      const eq = line.indexOf("=");
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key) values[key] = value;
    }
  } catch {
    // 文件不存在时返回空
  }
  return { values };
}

export function saveJudgeEnv(
  file: string,
  values: Record<string, string>,
): void {
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  Deno.writeTextFileSync(file, lines.join("\n") + "\n");
  Deno.chmodSync(file, 0o600);
}

export function setJudgeEnv(file: string, key: string, value: string): void {
  const env = loadJudgeEnv(file);
  env.values[key] = value;
  saveJudgeEnv(file, env.values);
}
