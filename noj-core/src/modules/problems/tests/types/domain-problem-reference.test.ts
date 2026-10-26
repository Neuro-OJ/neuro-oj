import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { BadRequestError } from "../../../../shared/base/errors.ts";
import {
  domainProblemReference,
  parseDomainProblemReference,
} from "../../services/workspace/problem-reference.ts";

Deno.test("域题号：明确解析数字及来源引用，拒绝旧分类、内部 ID 和歧义数字", () => {
  assertEquals(parseDomainProblemReference("1001"), {
    sourceSlug: null,
    number: 1001,
  });
  assertEquals(parseDomainProblemReference("main:1001"), {
    sourceSlug: "main",
    number: 1001,
  });
  for (
    const invalid of [
      "P1001",
      "U1001",
      "Main:1001",
      "main:01001",
      "0",
      "-1",
      "1.2",
      "2147483648",
      "school:main:1001",
      "../main:1001",
      crypto.randomUUID(),
    ]
  ) assertThrows(() => parseDomainProblemReference(invalid), BadRequestError);
});

Deno.test("域题号：引用显示来源号，本域仅显示数字，内部身份独立", () => {
  const problem = { id: "source-id", domain_id: "main-id", number: 1001 };
  assertEquals(domainProblemReference(problem, "main", "school-id"), {
    problem_id: "source-id",
    source_domain_id: "main-id",
    source_domain_slug: "main",
    number: 1001,
    qualified_ref: "main:1001",
    display_ref: "main:1001",
    is_shared: true,
  });
  assertEquals(
    domainProblemReference(problem, "main", "main-id").display_ref,
    "1001",
  );
});
