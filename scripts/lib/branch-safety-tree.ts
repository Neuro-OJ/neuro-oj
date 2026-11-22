/**
 * 分支安全自检 · 提交树读取。
 *
 * 检查对象必须与"待推送/待检查的提交"一致：**内容与存在性都从提交树取，不读工作区**。
 * 工作区可能停在别的分支、也可能有未提交改动——按工作区判存在性会让结果既可能漏报
 * （干净的文件被本地删掉）也可能误报（本地新建的文件冒充已提交）。
 *
 * 性能约定：一棵树只开两次 git 进程——`ls-tree` 取文件清单与目录集合，`cat-file --batch`
 * 按需取内容。逐文件 `git show` 在 Windows 上每次几十毫秒，扫描 180+ 文件会拖慢
 * pre-push 到无法接受。
 */

import { runGit } from "./branch-safety-git.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** 一份只读提交树（文件清单 + 按需内容 + 存在性）。 */
export interface TreeSource {
  /** 完整提交 SHA（读取内容的基准）。 */
  readonly commit: string;
  /** 提交里的全部文件（相对仓库根，按 `ls-tree` 顺序）。 */
  listFiles(): Promise<readonly string[]>;
  /** 读文件内容；提交树里没有该文件时返回 null。 */
  readFile(path: string): Promise<string | null>;
  /** 文件或目录是否存在于提交树里。 */
  exists(path: string): Promise<boolean>;
  /** 仓库顶层条目（用于识别"仓库内路径"形态的字符串字面量）。 */
  topLevel(): Promise<ReadonlySet<string>>;
  /** 释放 `cat-file` 子进程。 */
  close(): Promise<void>;
}

/** 把流包装成"读一行 / 读 N 字节"的游标。 */
class ByteReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer = new Uint8Array(0);

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  async #pull(): Promise<boolean> {
    const { done, value } = await this.#reader.read();
    if (done) return false;
    const merged = new Uint8Array(this.#buffer.length + value.length);
    merged.set(this.#buffer);
    merged.set(value, this.#buffer.length);
    this.#buffer = merged;
    return true;
  }

  /** 读到换行为止（不含换行）；流结束时返回 null。 */
  async readLine(): Promise<string | null> {
    while (true) {
      const newline = this.#buffer.indexOf(10);
      if (newline !== -1) {
        const line = this.#buffer.subarray(0, newline);
        this.#buffer = this.#buffer.subarray(newline + 1);
        return decoder.decode(line);
      }
      if (!(await this.#pull())) return null;
    }
  }

  /** 精确读 N 字节；流提前结束时返回 null。 */
  async readExact(length: number): Promise<Uint8Array | null> {
    while (this.#buffer.length < length) {
      if (!(await this.#pull())) return null;
    }
    const value = this.#buffer.slice(0, length);
    this.#buffer = this.#buffer.subarray(length);
    return value;
  }

  async cancel(): Promise<void> {
    try {
      await this.#reader.cancel();
    } catch {
      // 流已经结束
    }
  }
}

/**
 * `git cat-file --batch` 的长连接。
 *
 * 协议：写入 `<commit>:<path>` 后，git 回 `<oid> <type> <size>\n<内容>\n`；
 * 不存在时回 `<spec> missing\n`。逐个请求/响应，不需要把整棵树读进内存。
 */
class BatchBlobReader {
  readonly #commit: string;
  readonly #child: Deno.ChildProcess;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #reader: ByteReader;
  #failed = false;

  constructor(root: string, commit: string) {
    this.#commit = commit;
    this.#child = new Deno.Command("git", {
      args: ["-C", root, "-c", "core.quotepath=false", "cat-file", "--batch"],
      stdin: "piped",
      stdout: "piped",
      // 协议错误会表现为读不到内容；不把 git 的报错混进 hook 输出。
      stderr: "null",
    }).spawn();
    this.#writer = this.#child.stdin.getWriter();
    this.#reader = new ByteReader(this.#child.stdout);
  }

  async read(path: string): Promise<string | null> {
    // cat-file --batch 用换行分隔请求；含换行的路径无法安全表达（本仓库没有）。
    if (this.#failed || path.includes("\n")) return null;
    try {
      await this.#writer.write(encoder.encode(`${this.#commit}:${path}\n`));
    } catch {
      this.#failed = true;
      return null;
    }

    const header = await this.#reader.readLine();
    if (header === null) {
      this.#failed = true;
      return null;
    }
    if (header.endsWith(" missing")) return null;
    const matched = header.match(/^[0-9a-f]+ ([a-z]+) (\d+)$/);
    if (matched === null || matched[1] !== "blob") return null;

    const content = await this.#reader.readExact(Number(matched[2]));
    if (content === null) {
      this.#failed = true;
      return null;
    }
    // 每个 object 之后还有一个换行分隔符。
    await this.#reader.readExact(1);
    return decoder.decode(content);
  }

  async close(): Promise<void> {
    try {
      await this.#writer.close();
    } catch {
      // 子进程已退出
    }
    await this.#reader.cancel();
    try {
      await this.#child.status;
    } catch {
      // 已被回收
    }
  }
}

/**
 * 打开一个提交的只读树。
 *
 * `ls-tree -r -z` 一次拿到全部文件；目录集合由文件路径前缀推导（git 不跟踪空目录），
 * 所以 `exists("scripts/")` 这类目录探测也能命中。
 */
export async function openTreeSource(
  root: string,
  commit: string,
): Promise<TreeSource> {
  const { stdout } = await runGit(root, [
    "ls-tree",
    "-r",
    "-z",
    "--name-only",
    "--full-tree",
    commit,
  ]);
  const files = stdout.split("\0").filter((entry) => entry !== "");
  const fileSet = new Set(files);
  const directories = new Set<string>();
  const topLevel = new Set<string>();
  for (const file of files) {
    const segments = file.split("/");
    topLevel.add(segments[0]);
    for (let index = 1; index < segments.length; index++) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }

  const blobs = new BatchBlobReader(root, commit);
  const contentCache = new Map<string, string | null>();
  let closed = false;

  return {
    commit,
    listFiles: () => Promise.resolve(files),
    readFile: async (path) => {
      const cached = contentCache.get(path);
      if (cached !== undefined) return cached;
      const content = await blobs.read(path);
      contentCache.set(path, content);
      return content;
    },
    exists: (path) =>
      Promise.resolve(fileSet.has(path) || directories.has(path)),
    topLevel: () => Promise.resolve(topLevel),
    close: async () => {
      if (closed) return;
      closed = true;
      await blobs.close();
    },
  };
}
