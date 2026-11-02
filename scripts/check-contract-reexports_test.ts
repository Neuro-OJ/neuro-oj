import { assertEquals } from "jsr:@std/assert@^1";
import { isPureReexport } from "./check-contract-reexports.ts";

Deno.test("isPureReexport：纯 export {} from 视为转发层", () => {
  const source = `/** 注释 */
export {
  a,
  b,
} from "../impl.ts";
`;
  assertEquals(isPureReexport(source), true);
});

Deno.test("isPureReexport：含实现的文件不算转发层", () => {
  assertEquals(
    isPureReexport(`export { a } from "../impl.ts";\nexport function b() {}`),
    false,
  );
  assertEquals(
    isPureReexport(`export type X = { a: string };`),
    false,
  );
});

Deno.test("isPureReexport：多条重导出与 export * 都算", () => {
  assertEquals(
    isPureReexport(
      `export * from "./a.ts";\nexport type { B } from "./b.ts";`,
    ),
    true,
  );
});
