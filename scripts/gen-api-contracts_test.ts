import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { join } from "node:path";
import {
  CONTRACT_SOURCE_REL,
  CONTRACT_TARGETS_REL,
  renderGeneratedContract,
  syncApiContracts,
} from "./gen-api-contracts.ts";

Deno.test("gen-api-contracts: 拒绝含 import 或 Deno 运行时引用的契约源", () => {
  assertThrows(
    () => renderGeneratedContract('import { Foo } from "./foo.ts";\nexport type A = Foo;\n'),
    Error,
  );
  assertThrows(
    () => renderGeneratedContract("export const x = Deno.env.get('A');\n"),
    Error,
  );
});

Deno.test("gen-api-contracts: --check 能检出缺失或漂移，写入后保持幂等", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const src = join(tmp, CONTRACT_SOURCE_REL);
    await Deno.mkdir(join(src, ".."), { recursive: true });
    await Deno.writeTextFile(
      src,
      "export interface SampleDto {\n  id: string;\n}\n",
    );

    const before = await syncApiContracts(tmp, { checkOnly: true });
    assertEquals(before.changed.length, CONTRACT_TARGETS_REL.length);

    const written = await syncApiContracts(tmp, { checkOnly: false });
    assertEquals(written.changed.length, CONTRACT_TARGETS_REL.length);

    const after = await syncApiContracts(tmp, { checkOnly: true });
    assertEquals(after.changed, []);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
