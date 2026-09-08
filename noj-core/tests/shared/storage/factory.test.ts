/**
 * StorageProvider 工厂单元测试。
 */
import { assertEquals } from "jsr:@std/assert@^1";
import {
  getStorageProvider,
  getStorageProviderKind,
  resetStorageProvider,
  setStorageProviderForTest,
} from "../../../src/domains/system/services/storage/factory.ts";
import type { StorageProvider } from "../../../src/domains/system/services/storage/types.ts";

class FakeProvider implements StorageProvider {
  put(_key: string, data: Uint8Array): Promise<string> {
    return Promise.resolve(`fake://${data.length}`);
  }
  async putStream(
    _key: string,
    stream: ReadableStream<Uint8Array>,
  ): Promise<string> {
    const reader = stream.getReader();
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
    }
    return `fake-stream://${size}`;
  }
  get(_url: string): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array());
  }
  async delete(_url: string): Promise<void> {}
  downloadUrl(_storageUrl: string): Promise<string> {
    return Promise.resolve("fake-download");
  }
}

Deno.test("storage factory: 默认 provider kind 为 local", () => {
  resetStorageProvider();
  assertEquals(getStorageProviderKind(), "local");
});

Deno.test("storage factory: 注入测试 provider 后 getStorageProvider 返回该实例", async () => {
  resetStorageProvider();
  const fake = new FakeProvider();
  setStorageProviderForTest(fake);
  const provider = await getStorageProvider();
  assertEquals(provider, fake);
  resetStorageProvider();
});

Deno.test("storage factory: reset 后能再次获取 local 实例", async () => {
  resetStorageProvider();
  const provider = await getStorageProvider();
  assertEquals(provider.constructor.name, "LocalStorageProvider");
  resetStorageProvider();
});
