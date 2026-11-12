/**
 * 知识图谱功能对外出口（见 README.md）。
 *
 * 其他功能与旧模块只能从这里引用知识图谱能力；本目录内部文件互相直接引用。
 * 表定义在 `src/shared/db/schema/knowledge.ts`，只读 API 在 `routes.ts`。
 */
import { defineFeature } from "../../shared/feature.ts";
import { knowledgeRouter } from "./routes.ts";

export const feature = defineFeature({
  name: "knowledge",
  router: knowledgeRouter,
});

export {
  importPack,
  type ImportPackResult,
  KnowledgePackInvalidError,
} from "./import.ts";
export {
  invalidateKnowledgeGraphCache,
  KNOWLEDGE_GRAPH_CACHE_TTL_MS,
  type KnowledgeGraphView,
  type KnowledgeNodeView,
  readKnowledgeGraph,
  readKnowledgeNode,
} from "./graph.ts";
export {
  type KnowledgePack,
  loadPackFromDir,
  type PackArea,
  type PackNode,
  resolveOfficialPackDir,
  validatePack,
} from "./pack.ts";
