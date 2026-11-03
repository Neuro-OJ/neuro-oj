/**
 * 题包 ZIP 构造器（测试夹具专用）。
 *
 * 统一替代各 E2E 夹具里重复的"临时目录 + 写文件 + 外部 zip 进程"路径：普通题包
 * 内容直接在内存里打包，失败可定位到具体文件。恶意 ZIP、路径穿越、异常压缩格式
 * 与损坏包用例需要故意越界的内容，继续各自构造输入，不能复用本 builder。
 */
import { strToU8, zipSync } from "npm:fflate@0.8.2";

/** 题包内的文件内容：文本按 UTF-8 编码，二进制原样写入。 */
export type ProblemBundleFiles = Record<string, string | Uint8Array>;

/**
 * 在内存中构建题包 ZIP。
 *
 * @param files 相对路径 → 内容；空表与空路径直接失败（空题包只会在服务端
 *   产生难以归因的 400，应在夹具构造阶段暴露）
 */
export function buildProblemBundle(files: ProblemBundleFiles): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  const paths = Object.keys(files);
  if (paths.length === 0) {
    throw new Error("题包至少需要一个文件");
  }
  for (const [path, content] of Object.entries(files)) {
    if (path.trim() === "" || path.startsWith("/")) {
      throw new Error(`题包路径必须是相对路径：${JSON.stringify(path)}`);
    }
    entries[path] = typeof content === "string" ? strToU8(content) : content;
  }
  return zipSync(entries);
}

/** 把题包封装成 multipart 上传体（导入题包端点使用字段名 file）。 */
export function problemBundleForm(
  archive: Uint8Array,
  filename = "fixture.zip",
): FormData {
  const body = new FormData();
  body.set(
    "file",
    new Blob([archive.buffer as ArrayBuffer], { type: "application/zip" }),
    filename,
  );
  return body;
}
