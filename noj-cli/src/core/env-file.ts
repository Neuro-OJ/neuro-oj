import { dirname, join } from "@std/path";

/** 换行符（LF）。 */
const LF = String.fromCharCode(10);
/** 回车符（CR，用于归一化 CRLF）。 */
const CR = String.fromCharCode(13);
/** 制表符（用于去除行尾空白）。 */
const TAB = String.fromCharCode(9);

/**
 * .env.prod 读写原语：唯一配置格式（纯文本 KEY=value）的低层读写。
 *
 * 语义逐字对照 scripts/deploy/deploy.sh：
 * - env_value()（:181-191）—— 行首前缀匹配 + 首个匹配即返回 + 成对引号剥一层
 * - set_env_value()（:200-218）—— 就地替换全部 ^key= 行 + 未匹配则追加 +
 *   临时文件 chmod 600 + 原子 mv
 */

/** 生产配置文件权限：仅属主可读写。 */
export const ENV_FILE_MODE = 0o600;

/**
 * 去掉行尾的 CR（CRLF）与空白（空格 / Tab）。
 *
 * bash awk 读到 CR 时值会带上它；本实现按解析器惯例归一化行尾，避免 CRLF 文件的
 * 值被 CR 污染（否则成对引号剥离会因尾字符是 CR 而失效）。
 */
function normalizeLine(raw: string): string {
  const noCr = raw.endsWith(CR) ? raw.slice(0, -1) : raw;
  let end = noCr.length;
  while (end > 0) {
    const ch = noCr[end - 1];
    if (ch !== " " && ch !== TAB) break;
    end--;
  }
  return noCr.slice(0, end);
}

/**
 * 剥掉成对的首尾引号（单或双），只剥一层；引号不配对或长度不足 2 则原样返回。
 * 等价 bash 的 case """*"""|"'"*"'" 模式。
 */
function stripQuotes(value: string): string {
  const first = value[0];
  if (
    (first === '"' || first === "'") && value.length >= 2 &&
    value.endsWith(first)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * 解析 .env.prod 文本为键值表。
 *
 * - 跳过空行与 # 注释行（注释行即使形如 #KEY=... 也不产生键）。
 * - 只在首个等号处分割，值内允许再出现等号。
 * - 值若被成对的单引号或双引号包裹，剥掉一层引号。
 * - 同一键出现多次时取首个（与 bash env_value 首个匹配即 exit 一致）。
 */
export function parseEnvFile(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const raw of text.split(LF)) {
    const line = normalizeLine(raw);
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    // 首个匹配优先：后续同键行忽略，与 bash 的 exit 一致。
    if (entries.has(key)) continue;
    entries.set(key, stripQuotes(line.slice(eq + 1)));
  }
  return entries;
}

/** 在原文本末尾追加一行，保证结果以换行结尾（原文本为空时也只写这一行）。 */
function appendLine(text: string, line: string): string {
  if (text === "") return line + LF;
  if (text.endsWith(LF)) return text + line + LF;
  return text + LF + line + LF;
}

/**
 * 生成更新后的 .env.prod 文本，保留 original 的注释、空行与顺序。
 *
 * - 命中 ^key= 的每一行，仅当其解析值与 entries 中的值**不同**时才就地替换为
 *   key=value（重复键全部按此规则处理）；
 * - 值相同的行逐字节保留原样（含引号、行尾空白、CRLF），因此「读取后原样写回」
 *   是逐字节幂等的 —— 符合「仅改动的键就地更新」，避免无故剥离引号；
 * - 其他行（含注释、空行、未变更键）逐字节保留；
 * - entries 中未在原文本出现的键按 Map 迭代顺序追加到末尾。
 */
export function serializeEnvFile(
  entries: Map<string, string>,
  original: string,
): string {
  const out: string[] = [];
  const written = new Set<string>();
  for (const raw of original.split(LF)) {
    const line = normalizeLine(raw);
    const eq = line.indexOf("=");
    if (!line.startsWith("#") && eq > 0) {
      const key = line.slice(0, eq);
      const value = entries.get(key);
      if (value !== undefined) {
        // 值未变则保留原行（引号 / 空白 / CRLF 原样），实现幂等写回。
        out.push(
          stripQuotes(line.slice(eq + 1)) === value ? raw : key + "=" + value,
        );
        written.add(key);
        continue;
      }
    }
    out.push(raw);
  }
  let text = out.join(LF);
  for (const [key, value] of entries) {
    if (written.has(key)) continue;
    text = appendLine(text, key + "=" + value);
  }
  return text;
}

/** 读取存在文件的文本；文件不存在视为空文本。 */
async function readTextOrEmpty(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return "";
    throw err;
  }
}

/** 删除临时文件，忽略「本就不存在」的错误。 */
async function removeQuietly(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch {
    // 清理失败不覆盖原始错误
  }
}

/**
 * 异步读取并解析 .env.prod。
 *
 * 文件不存在时抛出错误而非返回空 Map —— 调用方需要区分「缺失配置」与
 * 「空配置」（后者返回空 Map）。
 */
export async function readEnvFile(path: string): Promise<Map<string, string>> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error("配置文件不存在：" + path);
    }
    throw err;
  }
  return parseEnvFile(text);
}

/**
 * 原子写入 .env.prod：同目录临时文件 -> chmod 600 -> rename 覆盖。
 *
 * 保留原文件的注释与顺序（见 serializeEnvFile）；文件不存在时视为空。
 * 任一步骤失败都会清理临时文件并抛出错误，原文件保持完整（rename 前不触碰）。
 */
export async function writeEnvFileAtomic(
  path: string,
  entries: Map<string, string>,
): Promise<void> {
  const tmp = join(
    dirname(path),
    ".env.prod.tmp-" + Deno.pid + "-" + crypto.randomUUID(),
  );
  try {
    const original = await readTextOrEmpty(path);
    const text = serializeEnvFile(entries, original);
    const file = await Deno.open(tmp, {
      create: true,
      write: true,
      truncate: true,
      mode: ENV_FILE_MODE,
    });
    try {
      await file.write(new TextEncoder().encode(text));
    } finally {
      file.close();
    }
    // 显式 chmod：open 的 mode 会被 umask 裁剪，而 bash set_env_value 恒为 600。
    await Deno.chmod(tmp, ENV_FILE_MODE);
    await Deno.rename(tmp, path);
  } catch (err) {
    await removeQuietly(tmp);
    throw err;
  }
}
