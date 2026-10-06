import { unzipSync, zipSync } from "fflate";
import { encodeBase64 } from "@std/encoding/base64";
import { BadRequestError } from "../../../shared/base/errors.ts";
import {
  buildBase64DownloadUrl,
  getStorageProvider,
  sha256Hex,
} from "../../system/index.ts";
import type { OiRuntimeConfig } from "../types/runtime-config.ts";

/** 自测只接收用户输入和可选预期输出，不接受文件路径或 checker。 */
export interface OiSelfTestCase {
  id: string;
  input: string;
  expected_output?: string;
}

/** 自测输入按字节限额；null 与空字符串不能混淆。 */
export function validateOiSelfTestCases(
  value: unknown,
): asserts value is OiSelfTestCase[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 30) {
    throw new BadRequestError("自测需要 1～30 个用例");
  }
  const ids = new Set<string>();
  let total = 0;
  for (const item of value) {
    if (
      !item || typeof item !== "object" || typeof item.id !== "string" ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(item.id) || ids.has(item.id) ||
      typeof item.input !== "string" ||
      (item.expected_output !== undefined &&
        typeof item.expected_output !== "string")
    ) {
      throw new BadRequestError("自测用例需要唯一 id、输入及可选预期输出");
    }
    ids.add(item.id);
    const bytes = new TextEncoder().encode(item.input).length +
      new TextEncoder().encode(item.expected_output ?? "").length;
    if (bytes > 256 * 1024) {
      throw new BadRequestError("单个自测用例不能超过 256 KiB");
    }
    total += bytes;
  }
  if (total > 1024 * 1024) {
    throw new BadRequestError("自测用例总大小不能超过 1 MiB");
  }
}

/** 从正式包中只选必要额外文件，生成无隐藏测试和 checker 的临时任务包。 */
export async function buildOiSelfTestPackage(
  config: OiRuntimeConfig,
  storageUrl: string | null,
  cases: OiSelfTestCase[],
): Promise<{ runtime_config: OiRuntimeConfig; download_url: string }> {
  validateOiSelfTestCases(cases);
  const entries: Record<string, Uint8Array> = Object.create(null);
  const extra = [
    ...(config.compile_extra_files ?? []),
    ...(config.user_extra_files ?? []),
  ];
  if (extra.length) {
    if (!storageUrl) throw new BadRequestError("题目缺少自测必需的额外文件");
    const storage = await getStorageProvider();
    const archive = unzipSync(await storage.get(storageUrl), {
      filter: (file) => extra.includes(file.name),
    });
    for (const path of extra) {
      if (!archive[path]) {
        throw new BadRequestError(`缺少自测额外文件：${path}`);
      }
      entries[path] = archive[path];
    }
  }
  const encoder = new TextEncoder();
  const runtime = {
    ...config,
    scoring_version: 2 as const,
    checker: { type: "default" as const },
    checker_extra_files: [],
    subtasks: [{
      id: "self_test",
      score: 100,
      scoring: "sum" as const,
      cases: cases.map((item, index) => {
        const input = `noj-self-test/${index + 1}.in`;
        const output = `noj-self-test/${index + 1}.out`;
        entries[input] = encoder.encode(item.input);
        entries[output] = encoder.encode(item.expected_output ?? "");
        return { id: item.id, input, output };
      }),
    }],
    self_test: {
      no_compare_inputs: cases.flatMap((item, index) =>
        item.expected_output === undefined
          ? [`noj-self-test/${index + 1}.in`]
          : []
      ),
    },
  };
  const packageBytes = zipSync(entries);
  return {
    runtime_config: runtime,
    // 使用已有下载协议，保留原始 base64 的 +、/、=，兼容已运行的 Worker。
    download_url: buildBase64DownloadUrl(
      encodeBase64(packageBytes),
      await sha256Hex(packageBytes),
    ),
  };
}
