import { assertEquals } from "jsr:@std/assert@^1";
import {
  checkUploadLimits,
  parseNginxUploadLocations,
  toMiB,
} from "./check-upload-limits.ts";

const APP = new Map([
  ["MAX_SUPPORT_PACKAGE_SIZE", 128],
  ["DEFAULT_ARTIFACT_MAX_SIZE_BYTES", 2048],
]);

Deno.test("toMiB：k/m/g 归一", () => {
  assertEquals(toMiB("128m"), 128);
  assertEquals(toMiB("2g"), 2048);
  assertEquals(toMiB("64k"), 0.0625);
});

Deno.test("parseNginxUploadLocations：只挑上传 location 并读出缓冲开关", () => {
  const conf = `
server {
  client_max_body_size 64m;
  location ~ ^/api/v1/problems/import-bundle$ {
    client_max_body_size 128m;
    proxy_request_buffering off;
  }
  location / { proxy_pass http://ui:3000; }
}`;
  const parsed = parseNginxUploadLocations(conf);
  assertEquals(parsed.length, 1);
  assertEquals(parsed[0]!.clientMaxBodySize, "128m");
  assertEquals(parsed[0]!.requestBuffering, true);
});

Deno.test("checkUploadLimits：代理小于应用上限即失败（审计 F6 回归）", () => {
  const conf = `
server {
  location ~ ^/api/v1/problems/import-bundle$ {
    client_max_body_size 64m;
    proxy_request_buffering off;
  }
}`;
  const issues = checkUploadLimits(conf, APP);
  assertEquals(issues.length, 1);
  assertEquals(issues[0]!.problem.includes("小于应用上限"), true);
});

Deno.test("checkUploadLimits：上传 location 未关闭请求体缓冲即失败", () => {
  const conf = `
server {
  location ~ ^/api/v1/submissions$ {
    client_max_body_size 2048m;
  }
}`;
  const issues = checkUploadLimits(conf, APP);
  assertEquals(issues.length, 1);
  assertEquals(issues[0]!.problem.includes("proxy_request_buffering"), true);
});

Deno.test("checkUploadLimits：一致时无问题", () => {
  const conf = `
server {
  location ~ ^/api/v1/submissions$ {
    client_max_body_size 2048m;
    proxy_request_buffering off;
  }
  location ~ ^/api/v1/problems/import-bundle$ {
    client_max_body_size 128m;
    proxy_request_buffering off;
  }
}`;
  assertEquals(checkUploadLimits(conf, APP), []);
});
