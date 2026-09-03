/**
 * 测试事务回滚隔离 preload。
 *
 * 通过 `deno test --preload=tests/preload.ts` 在测试模块加载前包装 `Deno.test`，
 * 为每个用例自动开启/回滚测试事务。
 *
 * 纯单元测试不调用 getDb()，因此不会初始化数据库，零额外开销。
 */
import {
  beginTestTransaction,
  isTestTransactionDisabled,
  rollbackTestTransaction,
} from "./../src/shared/db/connection.ts";

type TestFn = (t: Deno.TestContext) => void | Promise<void>;

interface NormalizedTestOptions {
  name?: string;
  fn: TestFn;
  ignore?: boolean;
  only?: boolean;
  sanitizeResources?: boolean;
  sanitizeOps?: boolean;
  sanitizeExit?: boolean;
  // 保留其他 Deno.test 选项透传
  [key: string]: unknown;
}

const originalTest = Deno.test.bind(Deno);

function normalizeArgs(args: unknown[]): NormalizedTestOptions | null {
  if (typeof args[0] === "string" && typeof args[1] === "function") {
    return { name: args[0], fn: args[1] as TestFn };
  }

  if (
    typeof args[0] === "string" &&
    typeof args[1] === "object" &&
    args[1] !== null &&
    typeof args[2] === "function"
  ) {
    return {
      ...(args[1] as Record<string, unknown>),
      name: args[0],
      fn: args[2] as TestFn,
    };
  }

  if (typeof args[0] === "object" && args[0] !== null) {
    const options = args[0] as Record<string, unknown>;
    if (typeof args[1] === "function") {
      return { ...options, fn: args[1] as TestFn };
    }
    return options as unknown as NormalizedTestOptions;
  }

  return null;
}

const wrappedTest = ((...args: unknown[]) => {
  const options = normalizeArgs(args);
  if (!options) {
    return originalTest(...(args as [never]));
  }

  const originalFn = options.fn;
  const wrappedFn: TestFn = async (t) => {
    if (isTestTransactionDisabled()) {
      return await originalFn(t);
    }
    await beginTestTransaction();
    try {
      await originalFn(t);
    } finally {
      await rollbackTestTransaction();
    }
  };

  return originalTest({ ...options, name: options.name!, fn: wrappedFn });
}) as typeof Deno.test;

Object.defineProperty(Deno, "test", {
  value: wrappedTest,
  writable: true,
  configurable: true,
});
