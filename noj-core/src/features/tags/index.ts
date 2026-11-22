/**
 * 题目标签功能对外出口（见 README.md）。
 *
 * 其他功能与旧模块只能从这里引用标签能力；本目录内部文件互相直接引用。
 * 表 `tags` / `problem_tags` 定义保留在 `src/shared/db/schema/catalog.ts`。
 */
import { defineFeature } from "../../shared/feature.ts";
import { tagsRouter } from "./routes.ts";

export const feature = defineFeature({
  name: "tags",
  router: tagsRouter,
});

export {
  createTag,
  type CreateTagInput,
  deleteTag,
  getTag,
  getTagIdsByNames,
  isValidTagKind,
  listTags,
  mergeTags,
  TAG_KINDS,
  type TagKind,
  type TagResponse,
  type TagWriteContext,
  updateTag,
  type UpdateTagInput,
} from "./service.ts";
