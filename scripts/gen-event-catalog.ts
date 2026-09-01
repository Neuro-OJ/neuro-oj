// 生成 SSE 事件目录（dev-docs/engineering/event-catalog.md）。
// 从 event-bus.ts 的 Channels 与 publishEvent 调用点生成。
// 用法：deno run -A scripts/gen-event-catalog.ts [--check]
import { relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname ?? ".", "..");
const EVENT_BUS_PATH = resolve(ROOT, "noj-core/src/lib/event-bus.ts");
const OUTPUT_PATH = resolve(ROOT, "dev-docs/engineering/event-catalog.md");
const CORE_SRC = resolve(ROOT, "noj-core/src");

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of Deno.readDirSync(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      files.push(...collectTsFiles(path));
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function extractChannelNames(): string[] {
  const text = Deno.readTextFileSync(EVENT_BUS_PATH);
  const block = /export const Channels = \{([\s\S]*?)\} as const;/.exec(text);
  if (!block) return [];
  const names: string[] = [];
  const re = /^\s*([A-Za-z][A-Za-z0-9]*)\s*[:(]/gm;
  for (const m of block[1].matchAll(re)) {
    names.push(m[1]);
  }
  return [...new Set(names)];
}

function findPublishSites(channelNames: string[]): Map<string, string[]> {
  const sites = new Map<string, string[]>();
  for (const file of collectTsFiles(CORE_SRC)) {
    const text = Deno.readTextFileSync(file);
    for (const name of channelNames) {
      const re = new RegExp(`Channels\\.${name}\\b`, "g");
      if (re.test(text)) {
        const rel = relative(ROOT, file);
        const list = sites.get(name) ?? [];
        list.push(rel);
        sites.set(name, list);
      }
    }
  }
  return sites;
}

function generate(
  channelNames: string[],
  sites: Map<string, string[]>,
): string {
  const lines: string[] = [
    "# NOJ SSE 事件目录",
    "",
    "> 由 `scripts/gen-event-catalog.ts` 生成，请勿手改。",
    "",
    "| 频道 | 发布位置 |",
    "| --- | --- |",
  ];
  for (const name of channelNames) {
    const files = (sites.get(name) ?? []).sort();
    lines.push(`| \`${name}\` | ${files.join("<br>") || "—"} |`);
  }
  return lines.join("\n") + "\n";
}

if (import.meta.main) {
  const check = Deno.args.includes("--check");
  const channelNames = extractChannelNames();
  const sites = findPublishSites(channelNames);
  const content = generate(channelNames, sites);
  if (check) {
    const existing = Deno.readTextFileSync(OUTPUT_PATH);
    if (existing !== content) {
      console.error(
        "事件目录已过期，请运行 deno run -A scripts/gen-event-catalog.ts",
      );
      Deno.exit(1);
    }
    console.log("事件目录最新");
  } else {
    Deno.writeTextFileSync(OUTPUT_PATH, content);
    console.log(`已生成 ${OUTPUT_PATH}`);
  }
}
