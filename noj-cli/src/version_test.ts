import { assertEquals } from "@std/assert";
import denoJson from "../deno.json" with { type: "json" };
import { VERSION } from "./version.ts";

Deno.test("VERSION 与 deno.json 的 version 一致", () => {
    assertEquals(VERSION, denoJson.version);
});
