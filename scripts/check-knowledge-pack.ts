/**
 * 知识图谱官方内容包门禁。
 *
 * 加载并校验 `noj-core/data/knowledge-graph`（ID 格式与唯一、领域非空、
 * 悬挂前置、环、未声明考纲），打印节点/领域数；失败 exit 1。
 * 官方包随版本发布，内容损坏必须在 CI 拦截——否则只有实例初始化时才会暴露。
 *
 * 直接引用 `pack.ts` 纯函数：`index.ts` 还会带出数据库代码，在仓库根没有
 * `drizzle-orm` 依赖映射，无法运行。
 */
import {
  loadPackFromDir,
  resolveOfficialPackDir,
  validatePack,
} from "../noj-core/src/features/knowledge/pack.ts";

const dir = resolveOfficialPackDir();
let pack;
try {
  pack = await loadPackFromDir(dir);
} catch (error) {
  console.error(`[知识图谱内容包] 加载失败：${dir}`);
  console.error(error instanceof Error ? error.message : String(error));
  Deno.exit(1);
}

const errors = validatePack(pack);
const nodes = pack.areas.reduce((sum, area) => sum + area.nodes.length, 0);
if (errors.length > 0) {
  console.error(
    `[知识图谱内容包] 校验失败：${pack.id}@${pack.version}（${dir}）`,
  );
  for (const item of errors) console.error(`  - ${item}`);
  Deno.exit(1);
}
console.log(
  `[知识图谱内容包] 校验通过：${pack.id}@${pack.version}，领域 ${pack.areas.length} 个，节点 ${nodes} 个`,
);
