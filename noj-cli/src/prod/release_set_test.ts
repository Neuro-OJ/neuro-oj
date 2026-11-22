import { assert, assertEquals, assertThrows } from "@std/assert";
import coreStandard from "../../../noj-core/src/modules/problems/types/noj-wasm-v3.json" with {
  type: "json",
};
import judgeStandard from "../../../noj-judge/src/oi/noj-wasm-v3.json" with {
  type: "json",
};
import {
  EVALUATION_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  RELEASE_SET_COMPONENT_IMAGES,
  RELEASE_SET_COMPONENTS,
  releaseSetDigestMismatches,
  SDK_STANDARD,
  validateReleaseSet,
} from "./release-set.ts";

const digest = (hex: string) => `sha256:${hex.repeat(64).slice(0, 64)}`;

Deno.test("release-set 标准与 Core/Judge 实际构建输入一致，拒绝旧标准", () => {
  assertEquals(SDK_STANDARD, coreStandard.id);
  assertEquals(SDK_STANDARD, judgeStandard.id);
  assertThrows(
    () =>
      validateReleaseSet({ ...validReleaseSet(), sdk_standard: "noj-wasm-v1" }),
    Error,
    "sdk_standard",
  );
});

function validReleaseSet() {
  return {
    schema_version: 1,
    release: "v0.10.5",
    migration_level: "0139",
    protocol_versions: {
      evaluation: EVALUATION_PROTOCOL_VERSION,
      gateway: GATEWAY_PROTOCOL_VERSION,
    },
    components: Object.fromEntries(RELEASE_SET_COMPONENTS.map((name, index) => [
      name,
      {
        image: RELEASE_SET_COMPONENT_IMAGES[name],
        digest: digest(String(index + 1)),
      },
    ])),
    cli_version: "v0.10.5",
    ide_version: "v0.10.5",
    sdk_standard: SDK_STANDARD,
  };
}

Deno.test("release-set 校验 tag、协议、组件和客户端版本绑定", () => {
  const parsed = validateReleaseSet(validReleaseSet(), "0.10.5");
  assertEquals(parsed.release, "v0.10.5");
  assertEquals(parsed.protocol_versions.evaluation, 3);
  assertEquals(parsed.components.core.image, "ghcr.io/neuro-oj/noj-server");
  assertThrows(
    () => validateReleaseSet(validReleaseSet(), "v0.10.6"),
    Error,
    "不一致",
  );
});

Deno.test("release-set 拒绝未知协议和错误 digest", () => {
  const badProtocol = validReleaseSet() as unknown as {
    protocol_versions: { gateway: number };
  };
  badProtocol.protocol_versions.gateway = 2;
  assertThrows(() => validateReleaseSet(badProtocol), Error, "必须为 3");

  const badDigest = validReleaseSet();
  badDigest.components.core!.digest = "sha256:bad";
  assertThrows(() => validateReleaseSet(badDigest), Error, "digest");
});

Deno.test("release-set 只对启用的资源池比较已验签镜像", () => {
  const parsed = validateReleaseSet(validReleaseSet());
  const verified = [
    {
      name: "noj-server",
      image: "ghcr.io/neuro-oj/noj-server:v0.10.5",
      digest: digest("1"),
    },
    {
      name: "noj-ui",
      image: "ghcr.io/neuro-oj/noj-ui:v0.10.5",
      digest: digest("2"),
    },
    {
      name: "noj-llm-gateway",
      image: "ghcr.io/neuro-oj/noj-llm-gateway:v0.10.5",
      digest: digest("4"),
    },
  ];
  assertEquals(releaseSetDigestMismatches(parsed, verified, false), []);
  assert(releaseSetDigestMismatches(parsed, verified, true).length > 0);
});
