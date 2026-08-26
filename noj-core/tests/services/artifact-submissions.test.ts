/**
 * Artifact 提交服务纯函数测试。
 */

import { assertEquals } from "jsr:@std/assert@^1";
import {
  DEFAULT_ARTIFACT_MAX_SIZE_BYTES,
  getArtifactHardLimit,
} from "../../src/services/submissions/artifact-submissions.ts";

Deno.test("artifact-submissions: 默认硬上限为 2GB", () => {
  const old = Deno.env.get("NOJ_ARTIFACT_MAX_SIZE_MB");
  Deno.env.delete("NOJ_ARTIFACT_MAX_SIZE_MB");
  try {
    assertEquals(getArtifactHardLimit(), DEFAULT_ARTIFACT_MAX_SIZE_BYTES);
  } finally {
    if (old === undefined) Deno.env.delete("NOJ_ARTIFACT_MAX_SIZE_MB");
    else Deno.env.set("NOJ_ARTIFACT_MAX_SIZE_MB", old);
  }
});

Deno.test("artifact-submissions: 环境变量可覆盖硬上限（MB）", () => {
  const old = Deno.env.get("NOJ_ARTIFACT_MAX_SIZE_MB");
  Deno.env.set("NOJ_ARTIFACT_MAX_SIZE_MB", "1024");
  try {
    assertEquals(getArtifactHardLimit(), 1024 * 1024 * 1024);
  } finally {
    if (old === undefined) Deno.env.delete("NOJ_ARTIFACT_MAX_SIZE_MB");
    else Deno.env.set("NOJ_ARTIFACT_MAX_SIZE_MB", old);
  }
});
